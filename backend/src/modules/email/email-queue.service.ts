import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { getRequestId } from "../../observability/request-context.js";
import { logger } from "../../utils/logger.js";
import { encryptEmailToken } from "./email-crypto.js";
import type { AuthEmailTemplate, EmailJobPayload } from "./email.types.js";
import { getQueueRegistry } from "../../jobs/queue-registry.js";

export interface EmailQueueOptions {
  encryptionKey?: string;
  requestId?: string;
  add?: (payload: EmailJobPayload, jobId: string) => Promise<unknown>;
  log?: typeof logger;
}

export async function enqueueAuthEmail(
  input: { to: string; template: AuthEmailTemplate; token: string; tokenId: string },
  options: EmailQueueOptions = {},
): Promise<{ jobId: string }> {
  const key = options.encryptionKey ?? env.EMAIL_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error("EMAIL_TOKEN_ENCRYPTION_KEY must be configured before queuing authentication email.");

  const requestId = options.requestId ?? getRequestId();
  const payload: EmailJobPayload = {
    to: input.to,
    template: input.template,
    encryptedToken: encryptEmailToken(input.token, key),
    ...(requestId ? { requestId } : {}),
  };
  const jobId = `auth-email-${input.tokenId || randomUUID()}`;
  if (options.add) {
    await options.add(payload, jobId);
  } else {
    await getQueueRegistry().queues.email.add("send-auth-email", payload, { jobId });
  }
  (options.log ?? logger).info("job_submitted", {
    queue: "fleetflow-email",
    jobId,
    requestId,
    template: input.template,
  });
  return { jobId };
}
