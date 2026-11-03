import assert from "node:assert/strict";
import { test } from "node:test";
import type { Queue } from "bullmq";
import { validateEnvironment } from "../src/config/env.js";
import { createDemoJobService } from "../src/jobs/demo-job.service.js";
import { buildDefaultJobOptions } from "../src/jobs/job-settings.js";
import { JOB_NAMES, QUEUE_NAMES, type DemoJobPayload, type DemoJobResult } from "../src/jobs/job-types.js";
import { runWithRequestContext } from "../src/observability/request-context.js";
import { createLogger, type LogFields } from "../src/utils/logger.js";
import { createWorkerShutdown } from "../src/jobs/worker-shutdown.js";

test("job configuration validates concurrency, retries, backoff, and retention values", () => {
  assert.throws(() => validateEnvironment({ JOB_WORKER_CONCURRENCY: "0" }), /JOB_WORKER_CONCURRENCY/);
  assert.throws(() => validateEnvironment({ JOB_MAX_ATTEMPTS: "1.5" }), /JOB_MAX_ATTEMPTS/);
  assert.throws(() => validateEnvironment({ JOB_BACKOFF_DELAY_MS: "20" }), /JOB_BACKOFF_DELAY_MS/);
  assert.throws(() => validateEnvironment({ JOB_FAILED_RETENTION_COUNT: "-1" }), /JOB_FAILED_RETENTION_COUNT/);
  assert.throws(() => validateEnvironment({ JOB_FAILED_RETENTION_COUNT: "0" }), /JOB_FAILED_RETENTION_COUNT/);

  const settings = {
    JOB_WORKER_CONCURRENCY: 4,
    JOB_MAX_ATTEMPTS: 5,
    JOB_BACKOFF_DELAY_MS: 750,
    JOB_COMPLETED_RETENTION_COUNT: 20,
    JOB_FAILED_RETENTION_COUNT: 30,
  };
  assert.deepEqual(buildDefaultJobOptions(settings), {
    attempts: 5,
    backoff: { type: "exponential", delay: 750 },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 30 },
  });
});

test("demo job service validates payload, creates a stable idempotency key, and propagates request ID", async () => {
  let submitted: { name: string; data: DemoJobPayload; options: { jobId: string } } | undefined;
  const queue = {
    async add(name: string, data: DemoJobPayload, options: { jobId: string }) {
      submitted = { name, data, options };
      return { id: options.jobId };
    },
  } as unknown as Queue<DemoJobPayload, DemoJobResult, typeof JOB_NAMES.demo>;
  const lines: string[] = [];
  const writer = createLogger("production", { log: (line) => lines.push(line) });
  const log = {
    info: (event: string, fields?: LogFields) => writer("info", event, fields),
    warn: (event: string, fields?: LogFields) => writer("warn", event, fields),
    error: (event: string, fields?: LogFields) => writer("error", event, fields),
  };
  const service = createDemoJobService(queue, log);

  const result = await runWithRequestContext("request-correlation-1", () => service.submit({ demoId: "sample_01" }));
  assert.deepEqual(result, { jobId: "demo-sample_01" });
  assert.equal(submitted?.name, JOB_NAMES.demo);
  assert.equal(submitted?.options.jobId, result.jobId);
  assert.equal(submitted?.data.requestId, "request-correlation-1");
  assert.match(lines[0], /job_submitted/);
  assert.match(lines[0], /request-correlation-1/);

  await assert.rejects(service.submit({ demoId: "invalid:job-id" }));
});

test("worker shutdown drains once and reports timeout safely", async () => {
  let closeCalls = 0;
  const exitCodes: number[] = [];
  const worker = {
    async close() { closeCalls += 1; },
  } as unknown as Pick<import("bullmq").Worker, "close">;
  const log = { info() {}, warn() {}, error() {} };
  const shutdown = createWorkerShutdown(worker, 100, { log, onExit: (code) => exitCodes.push(code) });
  const first = shutdown("SIGTERM");
  const duplicate = shutdown("SIGINT");
  assert.equal(first, duplicate);
  await Promise.all([first, duplicate]);
  assert.equal(closeCalls, 1);
  assert.deepEqual(exitCodes, [0]);

  const timedOutCodes: number[] = [];
  const hangingWorker = { close: () => new Promise<void>(() => undefined) } as unknown as Pick<import("bullmq").Worker, "close">;
  await createWorkerShutdown(hangingWorker, 10, { log, onExit: (code) => timedOutCodes.push(code) })("SIGTERM");
  assert.deepEqual(timedOutCodes, [1]);
});
