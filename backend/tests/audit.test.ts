import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditOutcome } from "../src/generated/prisma/client.js";
import { sanitizeAuditMetadata, writeAuditEvent } from "../src/modules/audit/audit.service.js";
import { auditLogQuerySchema } from "../src/modules/audit/audit.validation.js";
import type { AuditEventInput } from "../src/modules/audit/audit.types.js";

test("audit events persist typed actor/resource/outcome fields and support anonymous actors", async () => {
  const records: Array<Record<string, unknown>> = [];
  const client = {
    auditLog: {
      async create(args: { data: Record<string, unknown> }) {
        records.push(args.data);
        return args.data;
      },
    },
  } as any;

  const event: AuditEventInput = {
    actor: { userId: "b2b523ce-cc97-4ef7-9124-2db68caac13f", role: "ADMIN" },
    action: "users.status_update",
    resourceType: "user",
    resourceId: "805c19ca-2b5a-4f66-92d9-83f8c2c3c639",
    outcome: AuditOutcome.SUCCESS,
    metadata: { previousStatus: "ACTIVE", newStatus: "SUSPENDED" },
  };
  await writeAuditEvent(client, event);
  await writeAuditEvent(client, {
    action: "auth.login",
    resourceType: "auth_session",
    outcome: AuditOutcome.FAILURE,
    metadata: { reason: "unknown_user" },
  });

  assert.equal(records[0].actorUserId, event.actor?.userId);
  assert.equal(records[0].actorRole, "ADMIN");
  assert.equal(records[0].action, "users.status_update");
  assert.equal(records[0].outcome, "SUCCESS");
  assert.equal(records[1].actorUserId, null);
  assert.equal(records[1].actorRole, null);
  assert.equal(records[1].outcome, "FAILURE");
});

test("audit metadata allowlist drops credentials, personal values, nested input, and injected fields", () => {
  const metadata = sanitizeAuditMetadata({
    reason: "invalid_credentials",
    previousStatus: "ACTIVE",
    newStatus: "SUSPENDED",
    changedFields: ["email", "phone", "password", "constructor"],
    email: "private@example.test",
    password: "raw-password-marker",
    accessToken: "jwt-marker",
    headers: { authorization: "bearer-marker" },
    arbitrary: "injected-marker",
  });

  assert.deepEqual(metadata, {
    reason: "invalid_credentials",
    previousStatus: "ACTIVE",
    newStatus: "SUSPENDED",
    changedFields: ["email", "phone"],
  });
  assert.doesNotMatch(JSON.stringify(metadata), /private@example|raw-password|jwt-marker|bearer-marker|injected-marker/);
});

test("audit write logs only action metadata and no actor, IP, or sensitive payload", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const client = {
    auditLog: {
      async create(args: { data: Record<string, unknown> }) {
        return args.data;
      },
    },
  } as any;
  const result = await writeAuditEvent(client, {
    actor: { userId: "123e4567-e89b-12d3-a456-426614174000", role: "ADMIN" },
    action: "auth.login",
    resourceType: "user",
    resourceId: "123e4567-e89b-12d3-a456-426614174000",
    outcome: AuditOutcome.FAILURE,
    metadata: { reason: "invalid_credentials", password: "password-marker" },
  });
  assert.ok(result);
  const logText = lines.join(" ");
  assert.match(logText, /audit_record_staged/);
  assert.doesNotMatch(logText, /123e4567|password-marker|invalid_credentials/);
});

test("audit list filters validate positive pagination, UUID actors, enums, and date ranges", () => {
  const valid = auditLogQuerySchema.parse({
    page: "2",
    limit: "50",
    actorUserId: "123e4567-e89b-12d3-a456-426614174000",
    action: "auth.login",
    resourceType: "auth_session",
    resourceId: "session-1",
    outcome: "FAILURE",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(valid.page, 2);
  assert.equal(valid.limit, 50);
  assert.equal(valid.outcome, "FAILURE");

  assert.equal(auditLogQuerySchema.safeParse({ page: "0" }).success, false);
  assert.equal(auditLogQuerySchema.safeParse({ limit: "101" }).success, false);
  assert.equal(auditLogQuerySchema.safeParse({ actorUserId: "not-a-uuid" }).success, false);
  assert.equal(auditLogQuerySchema.safeParse({ outcome: "UNKNOWN" }).success, false);
  assert.equal(auditLogQuerySchema.safeParse({ from: "2026-02-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" }).success, false);
  assert.equal(auditLogQuerySchema.safeParse({ unexpected: "injected" }).success, false);
});
