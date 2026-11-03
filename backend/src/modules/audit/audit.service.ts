import { Prisma, type AuditOutcome, type UserRole } from "../../generated/prisma/client.js";
import { prisma } from "../../config/prisma.js";
import { getRequestId, getRequestIpAddress } from "../../observability/request-context.js";
import { logger } from "../../utils/logger.js";
import type { AuditEventInput, AuditLogFilters } from "./audit.types.js";

type AuditWriter = Pick<Prisma.TransactionClient, "auditLog">;

const metadataKeyAllowlist = new Set([
  "reason",
  "previousRole",
  "newRole",
  "previousStatus",
  "newStatus",
  "fromStatus",
  "toStatus",
  "status",
  "changedFields",
  "sessionRevoked",
]);

const allowedMetadataValues: Record<string, Set<string>> = {
  reason: new Set([
    "unknown_user", "invalid_credentials", "account_inactive", "invalid_token",
    "expired_token", "verification_completed", "password_reset_completed",
  ]),
  previousRole: new Set(["SUPER_ADMIN", "ADMIN", "DISPATCHER", "DRIVER", "CUSTOMER"]),
  newRole: new Set(["SUPER_ADMIN", "ADMIN", "DISPATCHER", "DRIVER", "CUSTOMER"]),
  previousStatus: new Set(["ACTIVE", "INACTIVE", "SUSPENDED", "PENDING_VERIFICATION"]),
  newStatus: new Set(["ACTIVE", "INACTIVE", "SUSPENDED", "PENDING_VERIFICATION"]),
  fromStatus: new Set(["PENDING", "ASSIGNED", "PICKED_UP", "IN_TRANSIT", "DELIVERED", "CANCELLED"]),
  toStatus: new Set(["PENDING", "ASSIGNED", "PICKED_UP", "IN_TRANSIT", "DELIVERED", "CANCELLED"]),
  status: new Set(["ACTIVE", "INACTIVE", "SUSPENDED", "PENDING_VERIFICATION", "PENDING", "ASSIGNED", "PICKED_UP", "IN_TRANSIT", "DELIVERED", "CANCELLED"]),
};

const allowedChangedFields = new Set(["firstName", "lastName", "email", "phone", "status", "driverId"]);

/** Strictly allow only small, non-sensitive audit metadata. Never store arbitrary payloads. */
export function sanitizeAuditMetadata(value: unknown): Prisma.InputJsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sanitized: Record<string, Prisma.InputJsonValue> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!metadataKeyAllowlist.has(key)) continue;

    if (key === "changedFields") {
      if (!Array.isArray(raw)) continue;
      const fields = [...new Set(raw.filter((field): field is string =>
        typeof field === "string" && allowedChangedFields.has(field)))].slice(0, 10);
      if (fields.length) sanitized[key] = fields;
      continue;
    }

    if (key === "sessionRevoked") {
      if (typeof raw === "boolean") sanitized[key] = raw;
      continue;
    }

    if (typeof raw === "string" && allowedMetadataValues[key]?.has(raw)) {
      sanitized[key] = raw;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized as Prisma.InputJsonObject : undefined;
}

function validateEvent(event: AuditEventInput) {
  if (!/^[a-z][a-z0-9_.-]{1,99}$/.test(event.action)) {
    throw new Error("Invalid audit action.");
  }
  if (!/^[a-z][a-z0-9_-]{1,49}$/.test(event.resourceType)) {
    throw new Error("Invalid audit resource type.");
  }
  if (event.resourceId && (event.resourceId.length > 100 || /[\u0000-\u001f\u007f]/.test(event.resourceId))) {
    throw new Error("Invalid audit resource ID.");
  }
}

export async function writeAuditEvent(client: AuditWriter, event: AuditEventInput) {
  validateEvent(event);
  const requestId = getRequestId();
  const ipAddress = getRequestIpAddress();
  const record = await client.auditLog.create({
    data: {
      actorUserId: event.actor?.userId ?? null,
      actorRole: (event.actor?.role ?? null) as UserRole | null,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId ?? null,
      outcome: event.outcome as AuditOutcome,
      requestId: requestId && requestId.length <= 100 ? requestId : null,
      ipAddress: event.captureIpAddress && ipAddress && ipAddress.length <= 45 ? ipAddress : null,
      metadata: sanitizeAuditMetadata(event.metadata),
    },
  });

  // This indicates a row was staged by the current transaction; the DB row is authoritative.
  logger.info("audit_record_staged", {
    requestId,
    action: event.action,
    resourceType: event.resourceType,
    outcome: event.outcome,
  });
  return record;
}

export async function recordAuditEvent(event: AuditEventInput) {
  const result = await prisma.$transaction((tx) => writeAuditEvent(tx, event));
  logger.info("audit_record_committed", {
    requestId: getRequestId(),
    action: event.action,
    resourceType: event.resourceType,
    outcome: event.outcome,
  });
  return result;
}

export async function listAuditLogs(filters: AuditLogFilters) {
  const where: Prisma.AuditLogWhereInput = {
    ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
    ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
    ...(filters.outcome ? { outcome: filters.outcome } : {}),
    ...(filters.from || filters.to ? {
      createdAt: {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      },
    } : {}),
  };
  const skip = (filters.page - 1) * filters.limit;
  const [records, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: filters.limit,
      select: {
        id: true,
        actorUserId: true,
        actorRole: true,
        action: true,
        resourceType: true,
        resourceId: true,
        outcome: true,
        requestId: true,
        ipAddress: true,
        metadata: true,
        createdAt: true,
      },
    }),
    prisma.auditLog.count({ where }),
  ]);
  return {
    records,
    pagination: {
      total,
      page: filters.page,
      limit: filters.limit,
      totalPages: Math.ceil(total / filters.limit),
      hasNextPage: filters.page * filters.limit < total,
      hasPreviousPage: filters.page > 1,
    },
  };
}
