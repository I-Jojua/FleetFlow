import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Worker } from "bullmq";
import { validateEnvironment } from "../src/config/env.js";
import { getBullMqRedisConnectionOptions } from "../src/config/redis.js";
import { JOB_NAMES, QUEUE_NAMES } from "../src/jobs/job-types.js";
import { createQueueRegistry } from "../src/jobs/queue-registry.js";
import { createEmailWorker } from "../src/modules/email/email-worker.js";
import { enqueueAuthEmail } from "../src/modules/email/email-queue.service.js";
import type { EmailJobPayload, EmailMessage, EmailProvider } from "../src/modules/email/email.types.js";
import { createLogger, type LogFields } from "../src/utils/logger.js";

const integrationUrl = process.env.FLEETFLOW_TEST_REDIS_URL;
const runIntegration = process.env.FLEETFLOW_RUN_INTEGRATION === "1";
if (runIntegration && !integrationUrl) throw new Error("FLEETFLOW_TEST_REDIS_URL is required for email queue integration tests.");
if (integrationUrl) {
  const parsed = new URL(integrationUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "56379" || parsed.pathname !== "/0") {
    throw new Error("Email queue integration tests require the isolated local Redis service.");
  }
}

const encryptionKey = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const settings = {
  ...validateEnvironment({ NODE_ENV: "test", EMAIL_TOKEN_ENCRYPTION_KEY: encryptionKey }),
  JOB_WORKER_CONCURRENCY: 2,
  JOB_MAX_ATTEMPTS: 3,
  JOB_BACKOFF_DELAY_MS: 100,
  JOB_COMPLETED_RETENTION_COUNT: 30,
  JOB_FAILED_RETENTION_COUNT: 30,
};
const prefix = `fleetflow-email-test-${randomUUID()}`;
let registry: ReturnType<typeof createQueueRegistry> | undefined;
const workers: Array<Worker<EmailJobPayload, any, typeof JOB_NAMES.email>> = [];

interface CapturedLog { event: string; fields?: LogFields; }
function captureLogs() {
  const entries: CapturedLog[] = [];
  return {
    entries,
    logger: {
      info: (event: string, fields?: LogFields) => entries.push({ event, fields }),
      warn: (event: string, fields?: LogFields) => entries.push({ event, fields }),
      error: (event: string, fields?: LogFields) => entries.push({ event, fields }),
    },
  };
}

function createWorker(provider: EmailProvider, log: ReturnType<typeof captureLogs>["logger"]) {
  const worker = createEmailWorker({
    redisUrl: integrationUrl,
    prefix,
    settings,
    provider,
    encryptionKey,
    log,
  });
  workers.push(worker);
  return worker;
}

function waitForJobEvent(
  worker: Worker<EmailJobPayload, any, typeof JOB_NAMES.email>,
  eventName: "completed" | "failed",
  jobId: string,
  minimumAttempts?: number,
): Promise<{ job: any; result?: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for email job ${eventName}.`));
    }, 10_000);
    const onEvent = (job: any, result?: unknown) => {
      if (job?.id !== jobId || (minimumAttempts !== undefined && job.attemptsMade < minimumAttempts)) return;
      clearTimeout(timer);
      worker.off(eventName, onEvent);
      resolve({ job, result });
    };
    worker.on(eventName, onEvent);
  });
}

async function enqueueEmail(input: { tokenId: string; token: string; template?: "verify-email" | "password-reset" }) {
  return enqueueAuthEmail({
    to: "integration@example.test",
    template: input.template ?? "verify-email",
    token: input.token,
    tokenId: input.tokenId,
  }, {
    encryptionKey,
    add: async (payload, jobId) => registry!.queues.email.add(JOB_NAMES.email, payload, { jobId }),
    log: {
      info: (event, fields) => createLogger("production", { log() {} })("info", event, fields),
      warn: (event, fields) => createLogger("production", { log() {} })("warn", event, fields),
      error: (event, fields) => createLogger("production", { log() {} })("error", event, fields),
    },
  });
}

before(async () => {
  if (!runIntegration) return;
  registry = createQueueRegistry({ redisUrl: integrationUrl, prefix, settings });
  await registry.queues.email.waitUntilReady();
});

after(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close().catch(() => undefined)));
  await registry?.close().catch(() => undefined);
});

test("email queue registration uses the centralized policy and typed queue", {
  skip: !runIntegration,
}, async () => {
  assert.equal(registry?.queues.email.name, QUEUE_NAMES.email);
  assert.equal(registry?.queues.email.opts.defaultJobOptions?.attempts, settings.JOB_MAX_ATTEMPTS);
  assert.deepEqual(registry?.queues.email.opts.defaultJobOptions?.backoff, { type: "exponential", delay: 100 });
});

test("email worker decrypts a queued token and sends HTML/text link without storing plaintext in Redis", {
  skip: !runIntegration,
}, async () => {
  const captured = captureLogs();
  const messages: EmailMessage[] = [];
  const provider: EmailProvider = {
    async send(message) { messages.push(message); return { delivered: true, provider: "resend" }; },
  };
  const worker = createWorker(provider, captured.logger);
  await worker.waitUntilReady();
  const token = `verification-${randomUUID()}`;
  const tokenId = randomUUID();
  const jobId = `auth-email-${tokenId}`;
  const completed = waitForJobEvent(worker, "completed", jobId);
  try {
    await enqueueEmail({ tokenId, token });
    const stored = await registry!.queues.email.getJob(jobId);
    assert.ok(stored);
    assert.equal(JSON.stringify(stored?.data).includes(token), false);
    assert.equal(stored?.data.requestId, undefined);
    const result = await completed;

    assert.equal(messages.length, 1);
    assert.match(messages[0].text, new RegExp(token));
    assert.match(messages[0].html, new RegExp(token));
    assert.equal(messages[0].to, "integration@example.test");
    assert.equal((result.result as { delivered: boolean }).delivered, true);
    assert.ok(captured.entries.some((entry) => entry.event === "job_completed"));
    assert.equal(JSON.stringify(captured.entries).includes(token), false);
    assert.equal(JSON.stringify(captured.entries).includes("integration@example.test"), false);
  } finally {
    await worker.close();
  }
});

test("email provider failure retries and later succeeds with the same one-time link", {
  skip: !runIntegration,
}, async () => {
  const captured = captureLogs();
  let attempts = 0;
  const messages: EmailMessage[] = [];
  const provider: EmailProvider = {
    async send(message) {
      attempts += 1;
      messages.push(message);
      if (attempts === 1) throw new Error("private provider response marker");
      return { delivered: true, provider: "resend" };
    },
  };
  const worker = createWorker(provider, captured.logger);
  await worker.waitUntilReady();
  const token = `retry-${randomUUID()}`;
  const tokenId = randomUUID();
  const jobId = `auth-email-${tokenId}`;
  const completed = waitForJobEvent(worker, "completed", jobId);
  try {
    await enqueueEmail({ tokenId, token, template: "password-reset" });
    await completed;
    assert.equal(attempts, 2);
    assert.equal(messages[0].text, messages[1].text);
    assert.equal(captured.entries.filter((entry) => entry.event === "job_retry_scheduled").length, 1);
    assert.equal(JSON.stringify(captured.entries).includes("private provider response marker"), false);
  } finally {
    await worker.close();
  }
});

test("permanent email provider failures retain failed jobs and log only safe metadata", {
  skip: !runIntegration,
}, async () => {
  const captured = captureLogs();
  const provider: EmailProvider = {
    async send() { throw new Error("private permanent provider body"); },
  };
  const worker = createWorker(provider, captured.logger);
  await worker.waitUntilReady();
  const tokenId = randomUUID();
  const jobId = `auth-email-${tokenId}`;
  const failed = waitForJobEvent(worker, "failed", jobId, settings.JOB_MAX_ATTEMPTS);
  try {
    await enqueueEmail({ tokenId, token: `permanent-${randomUUID()}` });
    const result = await failed;
    assert.equal(await result.job.getState(), "failed");
    assert.ok(captured.entries.some((entry) => entry.event === "job_failed"));
    assert.equal(JSON.stringify(captured.entries).includes("private permanent provider body"), false);
  } finally {
    await worker.close();
  }
});
