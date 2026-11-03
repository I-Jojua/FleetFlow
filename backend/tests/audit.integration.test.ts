import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import type { Express } from "express";
import { AuditOutcome, type UserRole } from "../src/generated/prisma/client.js";
import { runWithRequestContext } from "../src/observability/request-context.js";
import { writeAuditEvent } from "../src/modules/audit/audit.service.js";

const integrationUrl = process.env.FLEETFLOW_TEST_DATABASE_URL;
const runIntegration = process.env.FLEETFLOW_RUN_INTEGRATION === "1";
if (runIntegration && !integrationUrl) throw new Error("FLEETFLOW_TEST_DATABASE_URL is required for audit integration tests.");
if (integrationUrl) {
  const parsed = new URL(integrationUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432" || parsed.pathname !== "/fleetflow_test") {
    throw new Error("Audit integration tests require the isolated fleetflow_test database.");
  }
}

const prefix = `audit-integration-${randomUUID()}`;
const userIds: string[] = [];
let prisma: (typeof import("../src/config/prisma.js"))["prisma"] | undefined;
let env: (typeof import("../src/config/env.js"))["env"];

async function createUser(role: UserRole) {
  const user = await prisma!.user.create({
    data: {
      firstName: "Audit",
      lastName: "Integration",
      email: `${prefix}-${randomUUID()}@example.test`,
      passwordHash: await argon2.hash("Audit integration password 123", { type: argon2.argon2id }),
      role,
      status: "ACTIVE",
    },
  });
  userIds.push(user.id);
  return user;
}

function authHeader(userId: string, role: UserRole) {
  return `Bearer ${jwt.sign({ sub: userId, role }, env.JWT_ACCESS_SECRET)}`;
}

async function withApiServer<T>(callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const appModule = await import("../src/app.js");
  const server = createServer(appModule.default as unknown as Express);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind audit test server.");
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

before(async () => {
  if (!runIntegration) return;
  const [prismaModule, envModule] = await Promise.all([
    import("../src/config/prisma.js"),
    import("../src/config/env.js"),
  ]);
  prisma = prismaModule.prisma;
  env = envModule.env;
  const databaseInfo = await prisma.$queryRaw<Array<{ current_database: string; current_user: string }>>`SELECT current_database(), current_user`;
  assert.deepEqual(databaseInfo, [{ current_database: "fleetflow_test", current_user: "fleetflow_test" }]);
});

after(async () => {
  if (!runIntegration || !prisma) return;
  try {
    await prisma.user.deleteMany({ where: { id: { in: userIds }, email: { startsWith: prefix } } });
  } finally {
    const { closeRedisConnection } = await import("../src/config/redis.js");
    await Promise.all([prisma.$disconnect(), closeRedisConnection()]);
  }
});

test("audit rows persist actor snapshots, anonymous events, request correlation, and IP", {
  skip: !runIntegration,
}, async () => {
  const admin = await createUser("ADMIN");
  const auditId = randomUUID();
  await runWithRequestContext("audit-request-correlation", () => prisma!.$transaction((tx) => writeAuditEvent(tx, {
    actor: { userId: admin.id, role: admin.role },
    action: "audit.integration.success",
    resourceType: "audit_resource",
    resourceId: auditId,
    outcome: AuditOutcome.SUCCESS,
    captureIpAddress: true,
    metadata: { newStatus: "ACTIVE", password: "must-not-be-stored" },
  })), "203.0.113.20");
  await prisma!.auditLog.create({
    data: {
      action: "audit.integration.anonymous",
      resourceType: "auth_session",
      outcome: AuditOutcome.FAILURE,
    },
  });

  const record = await prisma!.auditLog.findFirstOrThrow({ where: { resourceId: auditId } });
  assert.equal(record.actorUserId, admin.id);
  assert.equal(record.actorRole, "ADMIN");
  assert.equal(record.requestId, "audit-request-correlation");
  assert.equal(record.ipAddress, "203.0.113.20");
  assert.deepEqual(record.metadata, { newStatus: "ACTIVE" });

  const anonymous = await prisma!.auditLog.findFirstOrThrow({ where: { action: "audit.integration.anonymous" } });
  assert.equal(anonymous.actorUserId, null);
  assert.equal(anonymous.actorRole, null);
});

test("audit writes roll back with their business transaction", {
  skip: !runIntegration,
}, async () => {
  const email = `${prefix}-rollback@example.test`;
  let rolledBackUserId: string | undefined;
  await assert.rejects(prisma!.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        firstName: "Rollback",
        lastName: "Audit",
        email,
        passwordHash: "not-a-real-hash",
        role: "CUSTOMER",
      },
    });
    rolledBackUserId = user.id;
    await writeAuditEvent(tx, {
      actor: { userId: user.id, role: user.role },
      action: "users.create",
      resourceType: "user",
      resourceId: user.id,
      outcome: AuditOutcome.SUCCESS,
    });
    throw new Error("force transaction rollback");
  }), /force transaction rollback/);

  assert.equal(await prisma!.user.count({ where: { email } }), 0);
  assert.equal(await prisma!.auditLog.count({ where: { resourceId: rolledBackUserId } }), 0);
});

test("login success and failures create persisted, non-sensitive audit events", {
  skip: !runIntegration,
}, async () => {
  const user = await createUser("CUSTOMER");
  const authService = await import("../src/modules/auth/auth.service.js");
  const signedIn = await runWithRequestContext(`${prefix}-login-success`, () =>
    authService.login({ email: user.email, password: "Audit integration password 123" }));
  await runWithRequestContext(`${prefix}-logout-success`, () => authService.logout(signedIn.tokens.refreshToken));
  await assert.rejects(runWithRequestContext(`${prefix}-login-failure`, () =>
    authService.login({ email: user.email, password: "wrong password marker" })));
  await assert.rejects(runWithRequestContext(`${prefix}-login-unknown`, () =>
    authService.login({ email: `${prefix}-unknown@example.test`, password: "unknown password marker" })));

  const entries = await prisma!.auditLog.findMany({
    where: { requestId: { startsWith: prefix }, action: { in: ["auth.login", "auth.logout"] } },
    orderBy: { createdAt: "desc" },
    take: 4,
  });
  assert.equal(entries.length, 4);
  assert.ok(entries.some((entry) => entry.outcome === "SUCCESS" && entry.actorUserId === user.id));
  assert.ok(entries.some((entry) => entry.action === "auth.logout" && entry.outcome === "SUCCESS" && entry.actorUserId === user.id));
  assert.ok(entries.some((entry) => entry.outcome === "FAILURE" && entry.actorUserId === null));
  assert.ok(entries.some((entry) => entry.outcome === "FAILURE" && entry.actorUserId === null && entry.resourceId === null));
  assert.doesNotMatch(JSON.stringify(entries), /wrong password marker|unknown password marker|@example\.test/);
});

test("audit API authorizes only administrators and applies filters with stable pagination", {
  skip: !runIntegration,
}, async () => {
  const admin = await createUser("ADMIN");
  const customer = await createUser("CUSTOMER");
  const dispatcher = await createUser("DISPATCHER");
  const resourceId = randomUUID();
  const from = new Date(Date.now() - 60_000);
  for (let index = 0; index < 2; index += 1) {
    await prisma!.auditLog.create({
      data: {
        actorUserId: admin.id,
        actorRole: admin.role,
        action: "audit.api.filter_test",
        resourceType: "audit_resource",
        resourceId,
        outcome: AuditOutcome.SUCCESS,
        metadata: { newStatus: "ACTIVE" },
      },
    });
  }

  await withApiServer(async (baseUrl) => {
    const query = new URLSearchParams({
      actorUserId: admin.id,
      action: "audit.api.filter_test",
      resourceType: "audit_resource",
      resourceId,
      outcome: "SUCCESS",
      from: from.toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
      page: "1",
      limit: "1",
    });
    const adminResponse = await fetch(`${baseUrl}/api/v1/audit-logs?${query}`, {
      headers: { authorization: authHeader(admin.id, admin.role) },
    });
    assert.equal(adminResponse.status, 200);
    const body = await adminResponse.json() as { data: Array<Record<string, unknown>>; pagination: { total: number; page: number; limit: number } };
    assert.equal(body.data.length, 1);
    assert.deepEqual(body.pagination, { total: 2, page: 1, limit: 1, totalPages: 2, hasNextPage: true, hasPreviousPage: false });
    assert.equal(body.data[0].resourceId, resourceId);

    const secondPageQuery = new URLSearchParams(query);
    secondPageQuery.set("page", "2");
    const secondPageResponse = await fetch(`${baseUrl}/api/v1/audit-logs?${secondPageQuery}`, {
      headers: { authorization: authHeader(admin.id, admin.role) },
    });
    assert.equal(secondPageResponse.status, 200);
    const secondPage = await secondPageResponse.json() as { data: Array<{ id: string }> };
    assert.notEqual(secondPage.data[0].id, body.data[0].id);

    assert.equal((await fetch(`${baseUrl}/api/v1/audit-logs`, { headers: { authorization: authHeader(customer.id, customer.role) } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/v1/audit-logs`, { headers: { authorization: authHeader(dispatcher.id, dispatcher.role) } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/v1/audit-logs`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/v1/audit-logs/${body.data[0].id}`, { headers: { authorization: authHeader(admin.id, admin.role) } })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/v1/audit-logs?page=0`, { headers: { authorization: authHeader(admin.id, admin.role) } })).status, 400);
  });
});
