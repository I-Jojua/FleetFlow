import type { AppEnvironment } from "../config/env.js";

export type JobSettings = Pick<
  AppEnvironment,
  | "JOB_WORKER_CONCURRENCY"
  | "JOB_MAX_ATTEMPTS"
  | "JOB_BACKOFF_DELAY_MS"
  | "JOB_COMPLETED_RETENTION_COUNT"
  | "JOB_FAILED_RETENTION_COUNT"
>;

export function buildDefaultJobOptions(settings: JobSettings) {
  return {
    attempts: settings.JOB_MAX_ATTEMPTS,
    backoff: {
      type: "exponential" as const,
      delay: settings.JOB_BACKOFF_DELAY_MS,
    },
    removeOnComplete: { count: settings.JOB_COMPLETED_RETENTION_COUNT },
    removeOnFail: { count: settings.JOB_FAILED_RETENTION_COUNT },
  };
}
