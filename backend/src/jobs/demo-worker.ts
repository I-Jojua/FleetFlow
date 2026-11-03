import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { env } from "../config/env.js";
import { getBullMqRedisConnectionOptions } from "../config/redis.js";
import { runWithRequestContext } from "../observability/request-context.js";
import { logger } from "../utils/logger.js";
import { JOB_NAMES, QUEUE_NAMES, type DemoJobPayload, type DemoJobResult } from "./job-types.js";

export type DemoJobProcessor = (job: Job<DemoJobPayload>) => Promise<DemoJobResult>;

export async function processDemoJob(
  job: Job<DemoJobPayload>,
  log: typeof logger = logger,
): Promise<DemoJobResult> {
  const requestId = job.data.requestId ?? `job-${job.id ?? "unknown"}`;
  return runWithRequestContext(requestId, async () => {
    log.info("job_started", {
      requestId,
      queue: QUEUE_NAMES.demo,
      jobId: job.id ?? "unknown",
      attempt: job.attemptsMade + 1,
    });

    const result = {
      demoId: job.data.demoId,
      processedAt: new Date().toISOString(),
    };
    log.info("job_completed", {
      requestId,
      queue: QUEUE_NAMES.demo,
      jobId: job.id ?? "unknown",
    });
    return result;
  });
}

export interface DemoWorkerOptions {
  prefix?: string;
  redisUrl?: string;
  settings?: typeof env;
  connection?: ConnectionOptions;
  processor?: DemoJobProcessor;
  log?: typeof logger;
}

export function createDemoWorker(options: DemoWorkerOptions = {}) {
  const settings = options.settings ?? env;
  const log = options.log ?? logger;
  const worker = new Worker<DemoJobPayload, DemoJobResult, typeof JOB_NAMES.demo>(
    QUEUE_NAMES.demo,
    options.processor ?? ((job) => processDemoJob(job, log)),
    {
      connection: options.connection ?? getBullMqRedisConnectionOptions(options.redisUrl),
      prefix: options.prefix ?? "fleetflow",
      concurrency: settings.JOB_WORKER_CONCURRENCY,
    },
  );

  worker.on("ready", () => {
    log.info("job_worker_ready", { queue: QUEUE_NAMES.demo });
  });
  worker.on("error", (error) => {
    log.error("job_worker_error", {
      queue: QUEUE_NAMES.demo,
      errorType: error.name,
    });
  });
  worker.on("failed", (job, error) => {
    const attempts = job?.opts.attempts ?? settings.JOB_MAX_ATTEMPTS;
    const fields = {
      queue: QUEUE_NAMES.demo,
      jobId: job?.id ?? "unknown",
      requestId: job?.data.requestId,
      attempt: job?.attemptsMade ?? 0,
      errorType: error.name,
    };

    if (job && job.attemptsMade < attempts) {
      log.warn("job_retry_scheduled", { ...fields, nextAttempt: job.attemptsMade + 1 });
      return;
    }
    log.error("job_failed", fields);
  });
  worker.on("stalled", (jobId) => {
    log.warn("job_stalled", { queue: QUEUE_NAMES.demo, jobId });
  });

  return worker;
}
