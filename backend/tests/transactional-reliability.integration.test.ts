import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import type { Express } from "express";
import { AuthTokenPurpose, OutboxStatus, type UserRole } from "../src/generated/prisma/client.js";
import { decryptEmailToken } from "../src/modules/email/email-crypto.js";
import { authEmailOutboxPayloadSchema } from "../src/jobs/outbox-types.js";
import { createOutboxDispatcher } from "../src/jobs/outbox-dispatcher.js";

const integrationUrl = process.env.FLEETFLOW_TEST_DATABASE_URL;
const runIntegration = process.env.FLEETFLOW_RUN_INTEGRATION === "1";
if (runIntegration && !integrationUrl) throw new Error("FLEETFLOW_TEST_DATABASE_URL is required for transactional reliability tests.");
if (integrationUrl) {
  const target = new URL(integrationUrl);
  if (target.hostname !== "127.0.0.1" || target.port !== "55432" || target.username !== "fleetflow_test" || target.pathname !== "/fleetflow_test") {
    throw new Error("Transactional reliability tests require the isolated fleetflow_test database on port 55432.");
  }
}

const prefix = `transactional-reliability-${randomUUID()}`;
const userIds: string[] = [];
const deliveryIds: string[] = [];
let prisma: (typeof import("../src/config/prisma.js"))["prisma"] | undefined;
let env: (typeof import("../src/config/env.js"))["env"];
let fetchOriginal: typeof fetch | undefined;

async function createUser(role: UserRole) {
  const user = await prisma!.user.create({
    data: {
      firstName: "Reliability",
      lastName: role,
      email: `${prefix}-${randomUUID()}@example.test`,
      passwordHash: "integration-only-placeholder",
      role,
      status: "ACTIVE",
    },
  });
  userIds.push(user.id);
  return user;
}

function authHeader(id: string, role: UserRole) {
  return `Bearer ${jwt.sign({ sub: id, role }, env.JWT_ACCESS_SECRET)}`;
}

async function withApiServer<T>(callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const appModule = await import("../src/app.js");
  const server = createServer(appModule.default as unknown as Express);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind transactional reliability test server.");
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function createDelivery(customerId: string, driverId?: string) {
  const delivery = await prisma!.delivery.create({
    data: {
      customerId,
      driverId,
      trackingCode: `FF-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
      recipientName: "Transaction Test Recipient",
      recipientPhone: "+15550000000",
      pickupAddress: "10 Transaction Test Pickup",
      deliveryAddress: "20 Transaction Test Delivery",
    },
  });
  deliveryIds.push(delivery.id);
  return delivery;
}

async function stageVerification(user: { id: string; email: string }) {
  const recovery = await import("../src/modules/auth/auth-recovery.service.js");
  await recovery.issueVerificationForNewUser(user);
  const token = await prisma!.authToken.findFirstOrThrow({
    where: { userId: user.id, purpose: AuthTokenPurpose.EMAIL_VERIFICATION },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const event = await prisma!.outboxEvent.findUniqueOrThrow({ where: { dedupeKey: `auth-email:${token.id}` } });
  return { token, event, payload: authEmailOutboxPayloadSchema.parse(event.payload) };
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
  fetchOriginal = globalThis.fetch;
  const slackWebhookUrl = env.SLACK_WEBHOOK_URL;
  globalThis.fetch = async (input, init) => {
    if (slackWebhookUrl && String(input) === slackWebhookUrl) return new Response("ok", { status: 200 });
    return fetchOriginal!(input, init);
  };
});

after(async () => {
  if (!runIntegration || !prisma) return;
  try {
    const tokens = userIds.length
      ? await prisma.authToken.findMany({ where: { userId: { in: userIds } }, select: { id: true } })
      : [];
    if (tokens.length) await prisma.outboxEvent.deleteMany({ where: { dedupeKey: { in: tokens.map((token) => `auth-email:${token.id}`) } } });
    if (deliveryIds.length) await prisma.delivery.deleteMany({ where: { id: { in: deliveryIds } } });
    if (userIds.length) {
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } finally {
    if (fetchOriginal) globalThis.fetch = fetchOriginal;
    const [{ closeRedisConnection }, { closeQueueRegistry }] = await Promise.all([
      import("../src/config/redis.js"),
      import("../src/jobs/queue-registry.js"),
    ]);
    await Promise.all([prisma.$disconnect(), closeRedisConnection(), closeQueueRegistry()]);
  }
});

test("concurrent delivery creation retries with one key create once; changed payload conflicts and expiry permits reuse", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER");
  const body = {
    recipientName: "Idempotent Recipient",
    recipientPhone: "+15550000001",
    pickupAddress: "10 Idempotency Pickup Street",
    deliveryAddress: "20 Idempotency Delivery Street",
  };

  await withApiServer(async (baseUrl) => {
    const submit = (payload: Record<string, unknown>, key = "delivery-create-0001") => fetch(`${baseUrl}/api/v1/deliveries`, {
      method: "POST",
      headers: {
        authorization: authHeader(customer.id, "CUSTOMER"),
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(payload),
    });
    const [left, right] = await Promise.all([submit(body), submit(body)]);
    assert.equal(left.status, 201);
    assert.equal(right.status, 201);
    const leftBody = await left.json() as { data: { id: string } };
    const rightBody = await right.json() as { data: { id: string } };
    assert.equal(leftBody.data.id, rightBody.data.id);
    deliveryIds.push(leftBody.data.id);
    assert.equal(await prisma!.delivery.count({ where: { customerId: customer.id } }), 1);
    assert.equal(await prisma!.idempotencyRecord.count({ where: { actorId: customer.id, operation: "deliveries.create" } }), 1);

    const changedPayload = await submit({ ...body, notes: "different payload" });
    assert.equal(changedPayload.status, 409);
    const conflictBody = await changedPayload.json() as { code: string };
    assert.equal(conflictBody.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(await prisma!.delivery.count({ where: { customerId: customer.id } }), 1);

    const invalidKey = await submit(body, "short");
    assert.equal(invalidKey.status, 400);
    const badKeyBody = await invalidKey.json() as { code: string };
    assert.equal(badKeyBody.code, "INVALID_IDEMPOTENCY_KEY");

    const storedKey = await prisma!.idempotencyRecord.findFirstOrThrow({
      where: { actorId: customer.id, operation: "deliveries.create" },
    });
    await prisma!.idempotencyRecord.update({ where: { id: storedKey.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const afterExpiry = await submit(body);
    assert.equal(afterExpiry.status, 201);
    const afterExpiryBody = await afterExpiry.json() as { data: { id: string } };
    assert.notEqual(afterExpiryBody.data.id, leftBody.data.id);
    deliveryIds.push(afterExpiryBody.data.id);
    assert.equal(await prisma!.delivery.count({ where: { customerId: customer.id } }), 2);
  });
});

test("assignment retries replay the same operation without duplicate delivery events or notifications", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER");
  const staff = await createUser("ADMIN");
  const driver = await createUser("DRIVER");
  const otherDriver = await createUser("DRIVER");
  const delivery = await createDelivery(customer.id);

  await withApiServer(async (baseUrl) => {
    const assign = (driverId: string) => fetch(`${baseUrl}/api/v1/deliveries/${delivery.id}/assign`, {
      method: "PATCH",
      headers: {
        authorization: authHeader(staff.id, "ADMIN"),
        "content-type": "application/json",
        "idempotency-key": "assignment-attempt-0001",
      },
      body: JSON.stringify({ driverId }),
    });
    const first = await assign(driver.id);
    const retry = await assign(driver.id);
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    const firstBody = await first.json() as { data: { driverId: string } };
    const retryBody = await retry.json() as { data: { driverId: string } };
    assert.equal(firstBody.data.driverId, driver.id);
    assert.equal(retryBody.data.driverId, driver.id);
    assert.equal(await prisma!.deliveryEvent.count({ where: { deliveryId: delivery.id, status: "ASSIGNED" } }), 1);
    assert.equal(await prisma!.notification.count({ where: { deliveryId: delivery.id } }), 2);

    const changedAssignment = await assign(otherDriver.id);
    assert.equal(changedAssignment.status, 409);
    assert.equal((await changedAssignment.json() as { code: string }).code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal((await prisma!.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).driverId, driver.id);
  });
});

test("registration and auth recovery persist encrypted email events atomically with their database changes", {
  skip: !runIntegration,
}, async () => {
  const auth = await import("../src/modules/auth/auth.service.js");
  const registered = await auth.register({
    firstName: "Outbox",
    lastName: "Registration",
    email: `${prefix}-register@example.test`,
    password: "Outbox integration password 123",
  });
  userIds.push(registered.user.id);
  assert.equal(registered.user.role, "CUSTOMER");
  assert.equal(registered.user.status, "PENDING_VERIFICATION");
  const verificationToken = await prisma!.authToken.findFirstOrThrow({
    where: { userId: registered.user.id, purpose: AuthTokenPurpose.EMAIL_VERIFICATION },
  });
  const verificationEvent = await prisma!.outboxEvent.findUniqueOrThrow({ where: { dedupeKey: `auth-email:${verificationToken.id}` } });
  const verification = {
    token: verificationToken,
    event: verificationEvent,
    payload: authEmailOutboxPayloadSchema.parse(verificationEvent.payload),
  };
  assert.equal(verification.token.purpose, AuthTokenPurpose.EMAIL_VERIFICATION);
  assert.notEqual(verification.payload.encryptedToken, decryptEmailToken(verification.payload.encryptedToken, env.EMAIL_TOKEN_ENCRYPTION_KEY!));
  assert.equal(JSON.stringify(verification.event.payload).includes(registered.user.email), false);
  assert.equal(await prisma!.auditLog.count({ where: { action: "users.create", resourceId: registered.user.id } }), 1);

  const rollbackEmail = `${prefix}-rollback@example.test`;
  let rolledBackId: string | undefined;
  const outboxCountBeforeRollback = await prisma!.outboxEvent.count();
  await assert.rejects(prisma!.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        firstName: "Rolled",
        lastName: "Back",
        email: rollbackEmail,
        passwordHash: "integration-placeholder",
        role: "CUSTOMER",
        status: "PENDING_VERIFICATION",
      },
    });
    rolledBackId = user.id;
    const recovery = await import("../src/modules/auth/auth-recovery.service.js");
    await recovery.stageVerificationForNewUser(tx, user);
    throw new Error("force transaction rollback");
  }), /force transaction rollback/);
  assert.equal(await prisma!.user.count({ where: { email: rollbackEmail } }), 0);
  assert.equal(await prisma!.authToken.count({ where: { userId: rolledBackId } }), 0);
  assert.equal(await prisma!.outboxEvent.count(), outboxCountBeforeRollback);

  const dispatcher = createOutboxDispatcher();
  await dispatcher.runOnce([verification.event.id]);
  const dispatched = await prisma!.outboxEvent.findUniqueOrThrow({ where: { id: verification.event.id } });
  assert.equal(dispatched.status, OutboxStatus.COMPLETED);
});

test("outbox dispatch enqueues stable BullMQ email jobs once and clears encrypted payload after success", {
  skip: !runIntegration,
}, async () => {
  const user = await createUser("CUSTOMER");
  const staged = await stageVerification(user);
  const dispatcher = createOutboxDispatcher();
  assert.equal(await dispatcher.runOnce([staged.event.id]), 1);
  const event = await prisma!.outboxEvent.findUniqueOrThrow({ where: { id: staged.event.id } });
  assert.equal(event.status, OutboxStatus.COMPLETED);
  assert.equal(event.payload, null);
  assert.ok(event.processedAt);
  assert.equal(await dispatcher.runOnce([staged.event.id]), 0);
  const { getQueueRegistry } = await import("../src/jobs/queue-registry.js");
  const job = await getQueueRegistry().queues.email.getJob(`auth-email-${staged.token.id}`);
  assert.ok(job);
  assert.notEqual(job.data.encryptedToken, decryptEmailToken(job.data.encryptedToken, env.EMAIL_TOKEN_ENCRYPTION_KEY!));
});

test("outbox retries Redis enqueue failures exponentially, records permanent failures, and reclaims abandoned work", {
  skip: !runIntegration,
}, async () => {
  const settings = {
    ...env,
    OUTBOX_POLL_INTERVAL_MS: 100,
    OUTBOX_LOCK_TIMEOUT_MS: 1_000,
    OUTBOX_BATCH_SIZE: 10,
    OUTBOX_MAX_ATTEMPTS: 2,
    OUTBOX_BACKOFF_BASE_MS: 100,
  };
  const retryUser = await createUser("CUSTOMER");
  const retryEvent = await stageVerification(retryUser);
  let clock = new Date();
  const capturedLogs: string[] = [];
  const log = {
    info: (event: string, fields?: unknown) => capturedLogs.push(JSON.stringify({ event, fields })),
    warn: (event: string, fields?: unknown) => capturedLogs.push(JSON.stringify({ event, fields })),
    error: (event: string, fields?: unknown) => capturedLogs.push(JSON.stringify({ event, fields })),
  } as unknown as typeof import("../src/utils/logger.js").logger;
  const failing = createOutboxDispatcher({
    db: prisma!,
    settings,
    now: () => clock,
    log,
    enqueue: async () => { throw new Error("redis password=private-marker unavailable"); },
  });
  await failing.runOnce([retryEvent.event.id]);
  let persisted = await prisma!.outboxEvent.findUniqueOrThrow({ where: { id: retryEvent.event.id } });
  assert.equal(persisted.status, OutboxStatus.PENDING);
  assert.equal(persisted.attempts, 1);
  assert.equal(persisted.lastErrorCode, "Error");
  assert.equal(JSON.stringify(persisted).includes("private-marker"), false);
  assert.doesNotMatch(capturedLogs.join(" "), /private-marker|redis password/);
  clock = new Date(Date.now() + 1_000);
  await failing.runOnce([retryEvent.event.id]);
  persisted = await prisma!.outboxEvent.findUniqueOrThrow({ where: { id: retryEvent.event.id } });
  assert.equal(persisted.status, OutboxStatus.FAILED);
  assert.equal(persisted.attempts, 2);
  assert.ok(persisted.failedAt);

  const recoveredUser = await createUser("CUSTOMER");
  const recovered = await stageVerification(recoveredUser);
  await prisma!.outboxEvent.update({
    where: { id: recovered.event.id },
    data: { status: OutboxStatus.PROCESSING, lockedAt: new Date(Date.now() - 60_000) },
  });
  let enqueueCount = 0;
  const recoveryDispatcher = createOutboxDispatcher({
    db: prisma!,
    settings,
    enqueue: async () => { enqueueCount += 1; return { jobId: "recovered-email-job" }; },
  });
  await Promise.all([
    recoveryDispatcher.runOnce([recovered.event.id]),
    recoveryDispatcher.runOnce([recovered.event.id]),
  ]);
  const recoveredEvent = await prisma!.outboxEvent.findUniqueOrThrow({ where: { id: recovered.event.id } });
  assert.equal(recoveredEvent.status, OutboxStatus.COMPLETED);
  assert.equal(enqueueCount, 1);
});
