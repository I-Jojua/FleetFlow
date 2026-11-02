import { prisma } from "../../config/prisma.js";
import { ensureRedisConnected, redis } from "../../config/redis.js";
import { metrics } from "../../observability/metrics.js";

export interface ReadinessChecks {
  database: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

export interface ReadinessResult {
  ready: boolean;
  dependencies: {
    database: boolean;
    redis: boolean;
  };
}

const defaultChecks: ReadinessChecks = {
  database: () => prisma.$queryRaw`SELECT 1`,
  redis: async () => {
    await ensureRedisConnected();
    return redis.ping();
  },
};

export async function getReadiness(
  checks: ReadinessChecks = defaultChecks,
): Promise<ReadinessResult> {
  const [database, redisCheck] = await Promise.allSettled([
    Promise.resolve().then(checks.database),
    Promise.resolve().then(checks.redis),
  ]);
  const dependencies = {
    database: database.status === "fulfilled",
    redis: redisCheck.status === "fulfilled",
  };
  metrics.setDependencyAvailability("database", dependencies.database);
  metrics.setDependencyAvailability("redis", dependencies.redis);

  return {
    ready: dependencies.database && dependencies.redis,
    dependencies,
  };
}
