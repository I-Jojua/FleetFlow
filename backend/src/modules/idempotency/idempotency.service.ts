import { createHash } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function validateIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function fingerprintRequest(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export interface IdempotentOperationResult<T> {
  result: T;
  statusCode: number;
  replayed: boolean;
}

export interface IdempotencyInput {
  actorId: string;
  operation: string;
  key: string;
  request: unknown;
  ttlHours: number;
  now?: Date;
}

/**
 * Execute a write under a transaction-scoped PostgreSQL advisory lock. The
 * unique index remains the final invariant; the lock lets concurrent retries
 * observe and replay the winning transaction before running business logic.
 */
export async function runIdempotently<T>(
  tx: Prisma.TransactionClient,
  input: IdempotencyInput,
  execute: (tx: Prisma.TransactionClient) => Promise<{
    result: T;
    resourceType: string;
    resourceId: string;
    statusCode: number;
  }>,
  loadResult: (tx: Prisma.TransactionClient, resourceType: string, resourceId: string) => Promise<T | null>,
): Promise<IdempotentOperationResult<T>> {
  if (!validateIdempotencyKey(input.key)) throw new Error("INVALID_IDEMPOTENCY_KEY");
  if (!Number.isInteger(input.ttlHours) || input.ttlHours < 1 || input.ttlHours > 168) {
    throw new Error("INVALID_IDEMPOTENCY_TTL");
  }

  const keyHash = sha256(input.key);
  const fingerprint = fingerprintRequest(input.request);
  const lockIdentity = sha256(`${input.actorId}\0${input.operation}\0${keyHash}`).slice(0, 15);
  await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(${BigInt(`0x${lockIdentity}`)})) AS idempotency_lock`;

  const uniqueWhere = {
    actorId_operation_keyHash: {
      actorId: input.actorId,
      operation: input.operation,
      keyHash,
    },
  };
  const now = input.now ?? new Date();
  const existing = await tx.idempotencyRecord.findUnique({ where: uniqueWhere });

  if (existing && existing.expiresAt > now) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new Error("IDEMPOTENCY_KEY_REUSED");
    }
    const result = await loadResult(tx, existing.resourceType, existing.resourceId);
    if (result === null) throw new Error("IDEMPOTENCY_RESULT_NOT_FOUND");
    return { result, statusCode: existing.responseStatus, replayed: true };
  }

  if (existing) {
    await tx.idempotencyRecord.delete({ where: { id: existing.id } });
  }

  const completed = await execute(tx);
  await tx.idempotencyRecord.create({
    data: {
      actorId: input.actorId,
      operation: input.operation,
      keyHash,
      requestFingerprint: fingerprint,
      resourceType: completed.resourceType,
      resourceId: completed.resourceId,
      responseStatus: completed.statusCode,
      expiresAt: new Date(now.getTime() + input.ttlHours * 60 * 60 * 1000),
    },
  });

  return { result: completed.result, statusCode: completed.statusCode, replayed: false };
}
