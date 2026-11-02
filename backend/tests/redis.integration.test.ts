import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import Redis from "ioredis";

const integrationUrl = process.env.FLEETFLOW_TEST_REDIS_URL;
const runIntegration = process.env.FLEETFLOW_RUN_INTEGRATION === "1";
let firstRedis: Redis | undefined;
let secondRedis: Redis | undefined;
let createRedisRateLimitStore: typeof import("../src/middleware/rate-limit.middleware.js").createRedisRateLimitStore;
let ensureRedisConnected: typeof import("../src/config/redis.js").ensureRedisConnected;
let closeSharedRedis: typeof import("../src/config/redis.js").closeRedisConnection;
let sharedRedis: typeof import("../src/config/redis.js").redis;
let getReadiness: typeof import("../src/modules/health/health.service.js").getReadiness;

if (runIntegration && !integrationUrl) {
  throw new Error("FLEETFLOW_TEST_REDIS_URL is required for Redis integration tests.");
}

if (integrationUrl) {
  const parsedUrl = new URL(integrationUrl);
  if (
    parsedUrl.hostname !== "127.0.0.1" ||
    parsedUrl.port !== "56379" ||
    parsedUrl.pathname !== "/0"
  ) {
    throw new Error("Redis integration tests require the dedicated local Redis instance on port 56379.");
  }
}

before(async () => {
  if (!runIntegration) return;
  process.env.REDIS_URL = integrationUrl!;
  process.env.NODE_ENV = "test";

  const [rateLimitModule, redisModule, healthModule] = await Promise.all([
    import("../src/middleware/rate-limit.middleware.js"),
    import("../src/config/redis.js"),
    import("../src/modules/health/health.service.js"),
  ]);
  createRedisRateLimitStore = rateLimitModule.createRedisRateLimitStore;
  ensureRedisConnected = redisModule.ensureRedisConnected;
  closeSharedRedis = redisModule.closeRedisConnection;
  sharedRedis = redisModule.redis;
  getReadiness = healthModule.getReadiness;

  firstRedis = new Redis(integrationUrl!, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 1_500,
  });
  secondRedis = new Redis(integrationUrl!, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 1_500,
  });
  await Promise.all([firstRedis.connect(), secondRedis.connect()]);
});

after(async () => {
  await Promise.all([
    firstRedis?.quit().catch(() => firstRedis?.disconnect()),
    secondRedis?.quit().catch(() => secondRedis?.disconnect()),
    closeSharedRedis?.(),
  ]);
});

test("separate Redis clients share atomic rate-limit counters with expiring keys", {
  skip: !runIntegration,
}, async () => {
  const namespace = `fleetflow:integration:${randomUUID()}`;
  const key = "login:shared-client";
  const firstStore = createRedisRateLimitStore(firstRedis!, namespace);
  const secondStore = createRedisRateLimitStore(secondRedis!, namespace);

  const first = await firstStore.increment(key, 250);
  const second = await secondStore.increment(key, 250);
  assert.equal(first.count, 1);
  assert.equal(second.count, 2);
  assert.ok(first.ttlMs > 0 && first.ttlMs <= 250);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterExpiry = await secondStore.increment(key, 250);
  assert.equal(afterExpiry.count, 1);
  await firstRedis!.del(`${namespace}:${key}`);

  let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  const readiness = await Promise.race([
    getReadiness({
      database: async () => "connected",
      redis: async () => {
        await ensureRedisConnected();
        return sharedRedis.ping();
      },
    }),
    new Promise<never>((_, reject) => {
      readinessTimer = setTimeout(() => reject(new Error(
        `Redis readiness timed out (client status: ${sharedRedis.status}, port: ${sharedRedis.options.port}).`,
      )), 3_000);
    }),
  ]).finally(() => {
    if (readinessTimer) clearTimeout(readinessTimer);
  });
  assert.deepEqual(readiness, {
    ready: true,
    dependencies: { database: true, redis: true },
  });
});
