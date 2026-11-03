import { z } from "zod";
import type { Queue } from "bullmq";
import { getRequestId } from "../observability/request-context.js";
import { logger } from "../utils/logger.js";
import { JOB_NAMES, QUEUE_NAMES, type DemoJobPayload, type DemoJobResult } from "./job-types.js";
import { getQueueRegistry } from "./queue-registry.js";

const demoJobPayloadSchema = z.object({
  demoId: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  requestId: z.string().min(1).max(128).optional(),
}).strict();

export function createDemoJobService(
  queue: Queue<DemoJobPayload, DemoJobResult, typeof JOB_NAMES.demo>,
  log: typeof logger = logger,
) {
  return {
    async submit(input: DemoJobPayload): Promise<{ jobId: string }> {
      const requestId = input.requestId ?? getRequestId();
      const payload = demoJobPayloadSchema.parse({
        ...input,
        ...(requestId ? { requestId } : {}),
      });
      const jobId = `demo-${payload.demoId}`;
      const job = await queue.add(JOB_NAMES.demo, payload, { jobId });

      log.info("job_submitted", {
        queue: QUEUE_NAMES.demo,
        jobId: job.id ?? jobId,
        requestId: payload.requestId,
      });
      return { jobId: job.id ?? jobId };
    },
  };
}

export async function submitDemoJob(input: DemoJobPayload): Promise<{ jobId: string }> {
  return createDemoJobService(getQueueRegistry().queues.demo).submit(input);
}
