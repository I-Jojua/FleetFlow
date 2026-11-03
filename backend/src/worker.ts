import { env } from "./config/env.js";
import { createDemoWorker } from "./jobs/demo-worker.js";
import { createEmailWorker } from "./modules/email/email-worker.js";
import { createWorkerShutdown } from "./jobs/worker-shutdown.js";
import { createOutboxDispatcher } from "./jobs/outbox-dispatcher.js";
import { QUEUE_NAMES } from "./jobs/job-types.js";
import { logger } from "./utils/logger.js";
import { locationRetentionWorker } from "./modules/deliveries/location-retention.js";

const outboxDispatcher = createOutboxDispatcher();
outboxDispatcher.start();
locationRetentionWorker.start();
const workers = [createDemoWorker(), createEmailWorker(), outboxDispatcher, locationRetentionWorker];
logger.info("job_worker_started", {
  queues: `${QUEUE_NAMES.demo},${QUEUE_NAMES.email}`,
  outbox: "enabled",
  gpsLocationRetention: "enabled",
  concurrency: env.JOB_WORKER_CONCURRENCY,
});

const shutdown = createWorkerShutdown(workers, env.GRACEFUL_SHUTDOWN_TIMEOUT_MS, {
  onExit: (code) => process.exit(code),
});

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
