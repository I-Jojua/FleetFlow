import type { AuditOutcome, UserRole } from "../../generated/prisma/client.js";

export interface AuditActor {
  userId: string;
  role: UserRole;
}

export interface AuditEventInput {
  actor?: AuditActor | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome: AuditOutcome;
  metadata?: unknown;
  captureIpAddress?: boolean;
}

export interface AuditLogFilters {
  actorUserId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: AuditOutcome;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}
