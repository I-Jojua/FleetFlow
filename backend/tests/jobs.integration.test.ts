import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Worker } from "bullmq";
import { validateEnvironment } from "../src/config/env.js";
import { getBullMqRedisConnectionOptions } from "../src/config/redis.js";
import { createDemoJobService } from "../src/jobs/demo-job.service.js";
import { createDemoWorker, type DemoJobProcessor } from "../src/jobs/demo-worker.js";
import { createQueueRegistry } from "../src/jobs/queue-registry.js";
import { createWorkerShutdown } from "../src/jobs/worker-shutdown.js";
import { JOB_NAMES, QUEUE_NAMES, type DemoJobPayload, type DemoJobResult } from "../src/jobs/job-types.js";
import { createLogger, type LogFields } from "../src/utils/logger.js";

const integrationUrl = process.env.FLEETFLOW_TEST_REDIS_URL;
const runIntegration = process.env.FLEETFLOW_RUN_INTEGRATION === "1";
if (runIntegration && !integrationUrl) {
  throw new Error("FLEETFLOW_TEST_REDIS_URL is required for background job integration tests.");
}
if (integrationUrl) {
  const parsed = new URL(integrationUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "56379" || parsed.pathname !== "/0") {
    throw new Error("Background job integration tests require the dedicated local Redis instance on port 56379.");
  }
}

interface CapturedLog {
  level: "info" | "warn" | "error";
  event: string;
  fields?: LogFields;
}

function captureLogger() {
  const events: CapturedLog[] = [];
  return {
    events,
    log: {
      info: (event: string, fields?: LogFields) => events.push({ level: "info", event, fields }),
      warn: (event: string, fields?: LogFields) => events.push({ level: "warn", event, fields }),
      error: (event: string, fields?: LogFields) => events.push({ level: "error", event, fields }),
    },
  };
}

function waitForJobEvent(
  worker: Worker<DemoJobPayload, DemoJobResult, typeof JOB_NAMES.demo>,
  eventName: "completed" | "failed",
  jobId: string,
  attemptsMade?: number,
): Promise<{ job: any; result?: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for job ${eventName}.`));
    }, 10_000);
    const onEvent = (job: any, result?: unknown) => {
      if (job?.id !== jobId || (attemptsMade !== undefined && job.attemptsMade < attemptsMade)) return;
      clearTimeout(timer);
      worker.off(eventName, onEvent);
      resolve({ job, result });
    };
    worker.on(eventName, onEvent);
  });
}

const settings = {
  ...validateEnvironment({ NODE_ENV: "test" }),
  JOB_WORKER_CONCURRENCY: 2,
  JOB_MAX_ATTEMPTS: 3,
  JOB_BACKOFF_DELAY_MS: 100,
  JOB_COMPLETED_RETENTION_COUNT: 20,
  JOB_FAILED_RETENTION_COUNT: 20,
};
const prefix = `fleetflow-jobs-test-${randomUUID()}`;
let registry: ReturnType<typeof createQueueRegistry> | undefined;
const workers: Array<Worker<DemoJobPayload, DemoJobResult, typeof JOB_NAMES.demo>> = [];

function makeWorker(options: { log: ReturnType<typeof captureLogger>["log"]; processor?: DemoJobProcessor } ) {
  const worker = createDemoWorker({
    redisUrl: integrationUrl,
    prefix,
    settings,
    log: options.log,
    processor: options.processor,
  });
  workers.push(worker);
  return worker;
}

before(async () => {
  if (!runIntegration) return;
  registry = createQueueRegistry({ redisUrl: integrationUrl, prefix, settings });
  await registry.queues.demo.waitUntilReady();
});

after(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close().catch(() => undefined)));
  await registry?.close().catch(() => undefined);
});

test("BullMQ queue registry applies typed registration and job retry/retention policy", {
  skip: !runIntegration,
}, async () => {
  assert.equal(registry?.queues.demo.name, QUEUE_NAMES.demo);
  assert.equal(registry?.queues.demo.opts.defaultJobOptions?.attempts, settings.JOB_MAX_ATTEMPTS);
  assert.deepEqual(registry?.queues.demo.opts.defaultJobOptions?.backoff, {
    type: "exponential",
    delay: settings.JOB_BACKOFF_DELAY_MS,
  });
  assert.deepEqual(registry?.queues.demo.opts.defaultJobOptions?.removeOnComplete, { count: 20 });
  assert.deepEqual(registry?.queues.demo.opts.defaultJobOptions?.removeOnFail, { count: 20 });
});

test("job submission persists in Redis, is correlated, and duplicate IDs return the same job", {
  skip: !runIntegration,
}, async () => {
  const captured = captureLogger();
  const service = createDemoJobService(registry!.queues.demo, captured.log);
  const demoId = `duplicate-${randomUUID()}`;
  const first = await service.submit({ demoId, requestId: "request-job-test" });
  const second = await service.submit({ demoId, requestId: "request-job-test" });
  const job = await registry!.queues.demo.getJob(first.jobId);

  assert.equal(first.jobId, second.jobId);
  assert.equal(job?.name, JOB_NAMES.demo);
  assert.equal(job?.data.demoId, demoId);
  assert.equal(job?.data.requestId, "request-job-test");
  assert.equal(await job?.getState(), "waiting");
  assert.equal(captured.events.filter((entry) => entry.event === "job_submitted").length, 2);
});

test("worker processes a submitted job and logs completion with its request ID", {
  skip: !runIntegration,
}, async () => {
  const captured = captureLogger();
  const worker = makeWorker({ log: captured.log });
  await worker.waitUntilReady();
  const demoId = `success-${randomUUID()}`;
  const jobId = `demo-${demoId}`;
  const completed = waitForJobEvent(worker, "completed", jobId);
  try {
    await createDemoJobService(registry!.queues.demo, captured.log).submit({ demoId, requestId: "request-success" });
    const result = await completed;

    assert.equal((result.result as DemoJobResult).demoId, demoId);
    assert.equal(result.job.attemptsMade, 1);
    assert.ok(captured.events.some((entry) => entry.event === "job_started" && entry.fields?.requestId === "request-success"));
    assert.ok(captured.events.some((entry) => entry.event === "job_completed" && entry.fields?.requestId === "request-success"));
  } finally {
    await worker.close();
  }
});

test("transient worker failures retry exponentially and eventually complete", {
  skip: !runIntegration,
}, async () => {
  const captured = captureLogger();
  let processorCalls = 0;
  const processor: DemoJobProcessor = async (job) => {
    processorCalls += 1;
    if (processorCalls < 3) throw new Error("simulated transient failure");
    return { demoId: job.data.demoId, processedAt: new Date().toISOString() };
  };
  const worker = makeWorker({ log: captured.log, processor });
  await worker.waitUntilReady();
  const demoId = `retry-${randomUUID()}`;
  const jobId = `demo-${demoId}`;
  const completed = waitForJobEvent(worker, "completed", jobId);
  try {
    await createDemoJobService(registry!.queues.demo, captured.log).submit({ demoId });
    await completed;

    assert.equal(processorCalls, 3);
    assert.equal(captured.events.filter((entry) => entry.event === "job_retry_scheduled").length, 2);
    assert.equal(captured.events.filter((entry) => entry.event === "job_failed").length, 0);
  } finally {
    await worker.close();
  }
});

test("permanent processor failures are retained and reported after the configured attempts", {
  skip: !runIntegration,
}, async () => {
  const captured = captureLogger();
  let processorCalls = 0;
  const worker = makeWorker({
    log: captured.log,
    processor: async () => {
      processorCalls += 1;
      throw new Error("simulated permanent failure");
    },
  });
  await worker.waitUntilReady();
  const demoId = `failed-${randomUUID()}`;
  const jobId = `demo-${demoId}`;
  const failed = waitForJobEvent(worker, "failed", jobId, settings.JOB_MAX_ATTEMPTS);
  try {
    await createDemoJobService(registry!.queues.demo, captured.log).submit({ demoId });
    const result = await failed;

    assert.equal(processorCalls, settings.JOB_MAX_ATTEMPTS);
    assert.equal(await result.job.getState(), "failed");
    assert.ok(captured.events.some((entry) => entry.event === "job_failed"));
    assert.equal(captured.events.some((entry) => JSON.stringify(entry).includes("simulated permanent failure")), false);
  } finally {
    await worker.close();
  }
});

test("worker shutdown closes Redis connections cleanly and accepts a single signal", {
  skip: !runIntegration,
}, async () => {
  const captured = captureLogger();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const worker = makeWorker({
    log: captured.log,
    processor: async (job) => {
      markStarted();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { demoId: job.data.demoId, processedAt: new Date().toISOString() };
    },
  });
  await worker.waitUntilReady();
  const demoId = `shutdown-${randomUUID()}`;
  const jobId = `demo-${demoId}`;
  const completed = waitForJobEvent(worker, "completed", jobId);
  await createDemoJobService(registry!.queues.demo, captured.log).submit({ demoId });
  await started;

  const exitCodes: number[] = [];
  const shutdown = createWorkerShutdown(worker, 2_000, {
    log: captured.log,
    onExit: (code) => exitCodes.push(code),
  });
  const first = shutdown("SIGTERM");
  const duplicate = shutdown("SIGINT");
  assert.equal(first, duplicate);
  await first;
  const finishedJob = await completed;
  assert.equal(finishedJob.job.id, jobId);
  assert.equal((worker as unknown as { closed: boolean }).closed, true);
  assert.deepEqual(exitCodes, [0]);
});

test("Redis connection failure rejects queue readiness and submission rather than dropping jobs", {
  skip: !runIntegration,
}, async () => {
  const captured = captureLogger();
  const unavailable = createQueueRegistry({
    prefix: `${prefix}-unavailable`,
    settings,
    log: captured.log,
    connection: getBullMqRedisConnectionOptions("redis://127.0.0.1:56401/0", {
      lazyConnect: true,
      connectTimeout: 150,
      retryStrategy: () => null,
    }),
  });
  await assert.rejects(unavailable.queues.demo.waitUntilReady());
  await assert.rejects(createDemoJobService(unavailable.queues.demo, captured.log).submit({
    demoId: `offline-${randomUUID()}`,
  }));
  assert.ok(captured.events.some((entry) => entry.event === "job_queue_error"));
  await unavailable.close().catch(() => undefined);
});
