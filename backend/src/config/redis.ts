import Redis from "ioredis";
import type { ConnectionOptions } from "bullmq";
import { env } from "./env.js";
import { logger } from "../utils/logger.js";

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 1_000,
  commandTimeout: 1_500,
  retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
});

/** BullMQ needs dedicated producer/worker clients with null maxRetriesPerRequest. */
export function getBullMqRedisConnectionOptions(
  redisUrl = env.REDIS_URL,
  overrides: Partial<Extract<ConnectionOptions, { url?: string }>> = {},
): Extract<ConnectionOptions, { url?: string }> {
  return {
    url: redisUrl,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    connectTimeout: 1_000,
    retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
    ...overrides,
  };
}

let connectionAttempt: Promise<void> | undefined;

export async function ensureRedisConnected(): Promise<void> {
  if (redis.status === "ready") return;

  if (redis.status === "wait") {
    connectionAttempt ??= redis.connect().finally(() => {
      connectionAttempt = undefined;
    });
    return connectionAttempt;
  }

  if (["connecting", "connect", "reconnecting"].includes(redis.status)) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        redis.off("ready", onReady);
        redis.off("error", onError);
      };
      const onReady = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      redis.once("ready", onReady);
      redis.once("error", onError);
    });
    return;
  }

  throw new Error("Redis is not connected.");
}

redis.on("error", (error: Error) => {
  logger.warn("redis_connection_error", { errorType: error.name });
});

export async function closeRedisConnection(): Promise<void> {
  if (redis.status === "end") return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      redis.quit(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Redis close timed out.")), 2_000);
        timer.unref();
      }),
    ]);
  } catch {
    redis.disconnect();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
