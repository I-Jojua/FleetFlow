import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { env } from "../../config/env.js";
import { getBullMqRedisConnectionOptions } from "../../config/redis.js";
import { runWithRequestContext } from "../../observability/request-context.js";
import { logger } from "../../utils/logger.js";
import { JOB_NAMES, QUEUE_NAMES } from "../../jobs/job-types.js";
import type { AppEnvironment } from "../../config/env.js";
import { decryptEmailToken } from "./email-crypto.js";
import { createAuthEmail } from "./email-templates.js";
import { emailProvider } from "./email-provider.js";
import type { EmailJobPayload, EmailProvider } from "./email.types.js";

export interface EmailWorkerOptions {
  redisUrl?: string;
  prefix?: string;
  settings?: AppEnvironment;
  connection?: ConnectionOptions;
  provider?: EmailProvider;
  log?: typeof logger;
  encryptionKey?: string;
}

export async function processEmailJob(
  job: Job<EmailJobPayload>,
  options: Pick<EmailWorkerOptions, "provider" | "log" | "encryptionKey" | "settings"> = {},
) {
  const settings = options.settings ?? env;
  const log = options.log ?? logger;
  const requestId = job.data.requestId ?? `job-${job.id ?? "unknown"}`;
  return runWithRequestContext(requestId, async () => {
    log.info("job_started", {
      requestId,
      queue: QUEUE_NAMES.email,
      jobId: job.id ?? "unknown",
      attempt: job.attemptsMade + 1,
      template: job.data.template,
    });
    const encryptionKey = options.encryptionKey ?? settings.EMAIL_TOKEN_ENCRYPTION_KEY;
    if (!encryptionKey) throw new Error("EMAIL_TOKEN_ENCRYPTION_KEY is not configured.");
    const token = decryptEmailToken(job.data.encryptedToken, encryptionKey);
    const message = createAuthEmail(job.data.template, token, {
      to: job.data.to,
      from: settings.EMAIL_FROM,
      appBaseUrl: settings.APP_BASE_URL,
    });
    const result = await (options.provider ?? emailProvider).send(message);
    if (!result.delivered) {
      log.warn("email_not_delivered", {
        requestId,
        queue: QUEUE_NAMES.email,
        jobId: job.id ?? "unknown",
        provider: result.provider,
        template: job.data.template,
      });
      return result;
    }

    log.info("job_completed", {
      requestId,
      queue: QUEUE_NAMES.email,
      jobId: job.id ?? "unknown",
      provider: result.provider,
      template: job.data.template,
    });
    return result;
  });
}

export function createEmailWorker(options: EmailWorkerOptions = {}) {
  const settings = options.settings ?? env;
  const log = options.log ?? logger;
  const worker = new Worker<EmailJobPayload, Awaited<ReturnType<typeof processEmailJob>>, typeof JOB_NAMES.email>(
    QUEUE_NAMES.email,
    (job) => processEmailJob(job, options),
    {
      connection: options.connection ?? getBullMqRedisConnectionOptions(options.redisUrl),
      prefix: options.prefix ?? "fleetflow",
      concurrency: settings.JOB_WORKER_CONCURRENCY,
    },
  );
  worker.on("ready", () => log.info("job_worker_ready", { queue: QUEUE_NAMES.email }));
  worker.on("error", (error) => log.error("job_worker_error", {
    queue: QUEUE_NAMES.email,
    errorType: error.name,
  }));
  worker.on("failed", (job, error) => {
    const attempts = job?.opts.attempts ?? settings.JOB_MAX_ATTEMPTS;
    const fields = {
      queue: QUEUE_NAMES.email,
      jobId: job?.id ?? "unknown",
      requestId: job?.data.requestId,
      template: job?.data.template,
      attempt: job?.attemptsMade ?? 0,
      errorType: error.name,
    };
    if (job && job.attemptsMade < attempts) {
      log.warn("job_retry_scheduled", { ...fields, nextAttempt: job.attemptsMade + 1 });
      return;
    }
    log.error("job_failed", fields);
  });
  worker.on("stalled", (jobId) => log.warn("job_stalled", {
    queue: QUEUE_NAMES.email,
    jobId,
  }));
  return worker;
}
