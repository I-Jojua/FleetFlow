
import app from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { closeRedisConnection } from "./config/redis.js";
import { closeQueueRegistry, getQueueRegistry } from "./jobs/queue-registry.js";
import { createGracefulShutdown } from "./server/graceful-shutdown.js";
import { logger } from "./utils/logger.js";

getQueueRegistry();

const server = app.listen(env.PORT, () => {
  logger.info("server_listening", {
    environment: env.NODE_ENV,
    port: env.PORT,
  });
});

const shutdown = createGracefulShutdown({
  server,
  timeoutMs: env.GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  closeDatabase: () => prisma.$disconnect(),
  closeQueues: closeQueueRegistry,
  closeRedis: closeRedisConnection,
  onExit: (code) => process.exit(code),
});

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
