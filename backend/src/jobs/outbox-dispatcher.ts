import { OutboxEventType, OutboxStatus, Prisma } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { authEmailOutboxPayloadSchema } from "./outbox-types.js";
import { decryptEmailToken } from "../modules/email/email-crypto.js";
import { enqueueAuthEmail } from "../modules/email/email-queue.service.js";
import { closeQueueRegistry } from "./queue-registry.js";
import { logger } from "../utils/logger.js";

type OutboxDatabase = typeof prisma;
type Log = typeof logger;

export interface OutboxDispatcherSettings {
  OUTBOX_POLL_INTERVAL_MS: number;
  OUTBOX_LOCK_TIMEOUT_MS: number;
  OUTBOX_BATCH_SIZE: number;
  OUTBOX_MAX_ATTEMPTS: number;
  OUTBOX_BACKOFF_BASE_MS: number;
  EMAIL_TOKEN_ENCRYPTION_KEY?: string;
}

export interface OutboxDispatcherOptions {
  db?: OutboxDatabase;
  settings?: OutboxDispatcherSettings;
  log?: Log;
  now?: () => Date;
  enqueue?: typeof enqueueAuthEmail;
}

function errorType(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z0-9_.-]{1,80}$/.test(name) ? name : "UnknownError";
}

export function createOutboxDispatcher(options: OutboxDispatcherOptions = {}) {
  const db = options.db ?? prisma;
  const settings = options.settings ?? env;
  const log = options.log ?? logger;
  const now = options.now ?? (() => new Date());
  const enqueue = options.enqueue ?? enqueueAuthEmail;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let loopPromise: Promise<void> | undefined;
  let activePass: Promise<number> | undefined;

  async function claimBatch(eventIds?: string[]) {
    const current = now();
    const staleBefore = new Date(current.getTime() - settings.OUTBOX_LOCK_TIMEOUT_MS);
    const candidates = await db.outboxEvent.findMany({
      where: {
        ...(eventIds?.length ? { id: { in: eventIds } } : {}),
        OR: [
          { status: OutboxStatus.PENDING, availableAt: { lte: current } },
          { status: OutboxStatus.PROCESSING, lockedAt: { lte: staleBefore } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: settings.OUTBOX_BATCH_SIZE,
    });

    const claimed: typeof candidates = [];
    for (const candidate of candidates) {
      const updated = await db.outboxEvent.updateMany({
        where: {
          id: candidate.id,
          OR: [
            { status: OutboxStatus.PENDING, availableAt: { lte: current } },
            { status: OutboxStatus.PROCESSING, lockedAt: { lte: staleBefore } },
          ],
        },
        data: {
          status: OutboxStatus.PROCESSING,
          lockedAt: current,
          attempts: { increment: 1 },
        },
      });
      if (updated.count === 1) claimed.push({ ...candidate, attempts: candidate.attempts + 1, lockedAt: current });
    }
    return claimed;
  }

  async function dispatchEvent(event: (Awaited<ReturnType<typeof claimBatch>>)[number]) {
    const lockAt = event.lockedAt;
    if (!lockAt) return;
    log.info("outbox_event_started", {
      eventId: event.id,
      eventType: event.eventType,
      attempt: event.attempts,
      requestId: event.requestId ?? undefined,
    });

    try {
      if (event.eventType !== OutboxEventType.AUTH_EMAIL || event.payload === null) {
        throw new Error("InvalidOutboxEvent");
      }
      const payload = authEmailOutboxPayloadSchema.parse(event.payload);
      const authToken = await db.authToken.findUnique({
        where: { id: payload.authTokenId },
        select: {
          expiresAt: true,
          consumedAt: true,
          invalidatedAt: true,
          user: { select: { email: true } },
        },
      });

      if (!authToken || authToken.expiresAt <= now() || authToken.consumedAt || authToken.invalidatedAt) {
        await db.outboxEvent.updateMany({
          where: { id: event.id, status: OutboxStatus.PROCESSING, lockedAt: lockAt },
          data: { status: OutboxStatus.COMPLETED, payload: Prisma.JsonNull, lockedAt: null, processedAt: now(), lastErrorCode: null },
        });
        log.info("outbox_event_skipped", { eventId: event.id, eventType: event.eventType });
        return;
      }

      const encryptionKey = settings.EMAIL_TOKEN_ENCRYPTION_KEY;
      if (!encryptionKey) throw new Error("EmailEncryptionKeyUnavailable");
      const token = decryptEmailToken(payload.encryptedToken, encryptionKey);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          enqueue({
            to: authToken.user.email,
            template: payload.template,
            token,
            tokenId: payload.authTokenId,
          }, { requestId: event.requestId ?? undefined, encryptionKey }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("OutboxEnqueueTimedOut")),
              Math.max(1_000, Math.min(settings.OUTBOX_LOCK_TIMEOUT_MS, 30_000)),
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      await db.outboxEvent.updateMany({
        where: { id: event.id, status: OutboxStatus.PROCESSING, lockedAt: lockAt },
        data: { status: OutboxStatus.COMPLETED, payload: Prisma.JsonNull, lockedAt: null, processedAt: now(), lastErrorCode: null },
      });
      log.info("outbox_event_completed", { eventId: event.id, eventType: event.eventType });
    } catch (error) {
      const finalFailure = event.attempts >= settings.OUTBOX_MAX_ATTEMPTS;
      const retryDelay = Math.min(
        settings.OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, event.attempts - 1),
        86_400_000,
      );
      const failureAt = now();
      await db.outboxEvent.updateMany({
        where: { id: event.id, status: OutboxStatus.PROCESSING, lockedAt: lockAt },
        data: {
          status: finalFailure ? OutboxStatus.FAILED : OutboxStatus.PENDING,
          lockedAt: null,
          availableAt: finalFailure ? event.availableAt : new Date(failureAt.getTime() + retryDelay),
          failedAt: finalFailure ? failureAt : null,
          lastErrorCode: errorType(error),
        },
      });
      log[finalFailure ? "error" : "warn"](finalFailure ? "outbox_event_failed" : "outbox_retry_scheduled", {
        eventId: event.id,
        eventType: event.eventType,
        attempt: event.attempts,
        nextAttempt: finalFailure ? undefined : event.attempts + 1,
        errorType: errorType(error),
      });
    }
  }

  async function runOnce(eventIds?: string[]): Promise<number> {
    const claimed = await claimBatch(eventIds);
    await Promise.all(claimed.map(dispatchEvent));
    return claimed.length;
  }

  async function loop() {
    while (!stopped) {
      try {
        activePass = runOnce();
        await activePass;
      } catch (error) {
        log.error("outbox_dispatcher_error", { errorType: errorType(error) });
      } finally {
        activePass = undefined;
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, settings.OUTBOX_POLL_INTERVAL_MS);
      });
      timer = undefined;
    }
  }

  return {
    runOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      loopPromise = loop();
      log.info("outbox_dispatcher_started", {
        pollIntervalMs: settings.OUTBOX_POLL_INTERVAL_MS,
        batchSize: settings.OUTBOX_BATCH_SIZE,
      });
    },
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (activePass) await activePass;
      await loopPromise;
      await closeQueueRegistry();
      loopPromise = undefined;
      log.info("outbox_dispatcher_stopped");
    },
  };
}
