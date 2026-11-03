import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import argon2 from "argon2";
import { AuthTokenPurpose } from "../src/generated/prisma/client.js";
import { decryptEmailToken } from "../src/modules/email/email-crypto.js";
import { authEmailOutboxPayloadSchema } from "../src/jobs/outbox-types.js";

const integrationUrl = process.env.FLEETFLOW_TEST_DATABASE_URL;
const runIntegration = process.env.FLEETFLOW_RUN_INTEGRATION === "1";
if (runIntegration && !integrationUrl) throw new Error("FLEETFLOW_TEST_DATABASE_URL is required for auth recovery integration tests.");
if (integrationUrl) {
  const parsed = new URL(integrationUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432" || parsed.pathname !== "/fleetflow_test") {
    throw new Error("Auth recovery integration tests require the isolated fleetflow_test database.");
  }
}

interface StagedEmail {
  template: "verify-email" | "password-reset";
  token: string;
  tokenId: string;
}

let prisma: (typeof import("../src/config/prisma.js"))["prisma"] | undefined;
let createAuthRecoveryService: typeof import("../src/modules/auth/auth-recovery.service.js").createAuthRecoveryService;
let encryptionKey: string;
const prefix = `auth-recovery-${randomUUID()}`;
const userIds: string[] = [];

async function createCustomer(status: "ACTIVE" | "PENDING_VERIFICATION" = "PENDING_VERIFICATION") {
  const user = await prisma!.user.create({
    data: {
      firstName: "Recovery",
      lastName: "Integration",
      email: `${prefix}-${randomUUID()}@example.test`,
      passwordHash: await argon2.hash("Original password value", { type: argon2.argon2id }),
      role: "CUSTOMER",
      status,
    },
  });
  userIds.push(user.id);
  return user;
}

function createRecovery() {
  return createAuthRecoveryService({ db: prisma! });
}

async function getStagedEmail(userId: string, purpose: AuthTokenPurpose): Promise<StagedEmail> {
  const token = await prisma!.authToken.findFirstOrThrow({
    where: { userId, purpose, invalidatedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const event = await prisma!.outboxEvent.findUniqueOrThrow({ where: { dedupeKey: `auth-email:${token.id}` } });
  const payload = authEmailOutboxPayloadSchema.parse(event.payload);
  return {
    tokenId: token.id,
    template: payload.template,
    token: decryptEmailToken(payload.encryptedToken, encryptionKey),
  };
}

async function getStagedEmailCount(userId: string, purpose: AuthTokenPurpose): Promise<number> {
  const tokens = await prisma!.authToken.findMany({ where: { userId, purpose }, select: { id: true } });
  return prisma!.outboxEvent.count({ where: { dedupeKey: { in: tokens.map((token) => `auth-email:${token.id}`) } } });
}

before(async () => {
  if (!runIntegration) return;
  const [prismaModule, recoveryModule, envModule] = await Promise.all([
    import("../src/config/prisma.js"),
    import("../src/modules/auth/auth-recovery.service.js"),
    import("../src/config/env.js"),
  ]);
  prisma = prismaModule.prisma;
  createAuthRecoveryService = recoveryModule.createAuthRecoveryService;
  encryptionKey = envModule.env.EMAIL_TOKEN_ENCRYPTION_KEY!;
  const databaseInfo = await prisma!.$queryRaw<Array<{ current_database: string; current_user: string }>>`SELECT current_database(), current_user`;
  assert.deepEqual(databaseInfo, [{ current_database: "fleetflow_test", current_user: "fleetflow_test" }]);
});

after(async () => {
  if (!runIntegration || !prisma) return;
  if (userIds.length) {
    const tokens = await prisma.authToken.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    if (tokens.length) await prisma.outboxEvent.deleteMany({ where: { dedupeKey: { in: tokens.map((token) => `auth-email:${token.id}`) } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds }, email: { startsWith: prefix } } });
  }
  await prisma.$disconnect();
});

test("verification succeeds, activates a pending customer, stores only a hash, and consumes the token once", {
  skip: !runIntegration,
}, async () => {
  const user = await createCustomer();
  const recovery = createRecovery();
  await recovery.issueVerificationForNewUser({ id: user.id, email: user.email });
  const email = await getStagedEmail(user.id, AuthTokenPurpose.EMAIL_VERIFICATION);
  const stored = await prisma!.authToken.findUniqueOrThrow({ where: { id: email.tokenId } });
  assert.equal(stored.purpose, AuthTokenPurpose.EMAIL_VERIFICATION);
  assert.equal(stored.tokenHash, createHash("sha256").update(email.token).digest("hex"));
  assert.notEqual(stored.tokenHash, email.token);

  await recovery.verifyEmail(email.token);
  const updated = await prisma!.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(updated.status, "ACTIVE");
  assert.ok(updated.emailVerifiedAt);
  assert.ok((await prisma!.authToken.findUniqueOrThrow({ where: { id: email.tokenId } })).consumedAt);
  assert.equal(await prisma!.auditLog.count({
    where: { action: "auth.email.verify", resourceId: user.id, outcome: "SUCCESS" },
  }), 1);
  await assert.rejects(recovery.verifyEmail(email.token), /invalid or expired/);
});

test("unverified accounts cannot sign in or exchange refresh tokens before verification", {
  skip: !runIntegration,
}, async () => {
  const user = await createCustomer();
  const auth = await import("../src/modules/auth/auth.service.js");
  await assert.rejects(auth.login({ email: user.email, password: "Original password value" }), (error: unknown) => {
    assert.equal((error as { statusCode?: number }).statusCode, 403);
    return true;
  });

  const rawRefreshToken = `pending-refresh-${randomUUID()}`;
  await prisma!.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: createHash("sha256").update(rawRefreshToken).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await assert.rejects(auth.refresh(rawRefreshToken), (error: unknown) => {
    assert.equal((error as { statusCode?: number }).statusCode, 403);
    return true;
  });
});

test("verification rejects invalid and expired tokens", {
  skip: !runIntegration,
}, async () => {
  const user = await createCustomer();
  const recovery = createRecovery();
  await recovery.issueVerificationForNewUser({ id: user.id, email: user.email });
  const email = await getStagedEmail(user.id, AuthTokenPurpose.EMAIL_VERIFICATION);
  await assert.rejects(recovery.verifyEmail("unknown-invalid-verification-token"), /invalid or expired/);
  await prisma!.authToken.update({ where: { id: email.tokenId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
  await assert.rejects(recovery.verifyEmail(email.token), /invalid or expired/);
  assert.equal((await prisma!.user.findUniqueOrThrow({ where: { id: user.id } })).status, "PENDING_VERIFICATION");
});

test("resend invalidates previous token and verified accounts do not receive new mail", {
  skip: !runIntegration,
}, async () => {
  const user = await createCustomer();
  const recovery = createRecovery();
  await recovery.issueVerificationForNewUser({ id: user.id, email: user.email });
  const originalEmail = await getStagedEmail(user.id, AuthTokenPurpose.EMAIL_VERIFICATION);
  await recovery.resendVerification(user.email);
  assert.equal(await getStagedEmailCount(user.id, AuthTokenPurpose.EMAIL_VERIFICATION), 2);
  const nextEmail = await getStagedEmail(user.id, AuthTokenPurpose.EMAIL_VERIFICATION);
  const oldRecord = await prisma!.authToken.findUniqueOrThrow({ where: { id: originalEmail.tokenId } });
  assert.ok(oldRecord.invalidatedAt);
  await assert.rejects(recovery.verifyEmail(originalEmail.token), /invalid or expired/);
  await recovery.verifyEmail(nextEmail.token);
  await recovery.resendVerification(user.email);
  assert.equal(await getStagedEmailCount(user.id, AuthTokenPurpose.EMAIL_VERIFICATION), 2);
});

test("password reset changes password and revokes every active refresh session", {
  skip: !runIntegration,
}, async () => {
  const user = await createCustomer("ACTIVE");
  const recovery = createRecovery();
  const now = new Date();
  await prisma!.refreshToken.createMany({ data: ["refresh-old-a", "refresh-old-b"].map((token) => ({
    userId: user.id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(now.getTime() + 60_000),
  })) });
  await recovery.requestPasswordReset(user.email);
  const email = await getStagedEmail(user.id, AuthTokenPurpose.PASSWORD_RESET);
  assert.equal(await getStagedEmailCount(user.id, AuthTokenPurpose.PASSWORD_RESET), 1);
  assert.equal(email.template, "password-reset");
  await recovery.resetPassword(email.token, "New password value 123");

  const updated = await prisma!.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(await argon2.verify(updated.passwordHash, "New password value 123"), true);
  assert.equal(await argon2.verify(updated.passwordHash, "Original password value"), false);
  assert.equal(await prisma!.refreshToken.count({ where: { userId: user.id, revokedAt: null } }), 0);
  assert.equal(await prisma!.auditLog.count({
    where: { action: "auth.password_reset", resourceId: user.id, outcome: "SUCCESS" },
  }), 1);
  assert.ok((await prisma!.authToken.findUniqueOrThrow({ where: { id: email.tokenId } })).consumedAt);
  await assert.rejects(recovery.resetPassword(email.token, "Another password value 123"), /invalid or expired/);
});

test("password reset rejects invalid and expired tokens and preserves the current password", {
  skip: !runIntegration,
}, async () => {
  const user = await createCustomer("ACTIVE");
  const recovery = createRecovery();
  await recovery.requestPasswordReset(user.email);
  const email = await getStagedEmail(user.id, AuthTokenPurpose.PASSWORD_RESET);
  await assert.rejects(recovery.resetPassword("unknown-invalid-reset-token", "New password value 123"), /invalid or expired/);
  await prisma!.authToken.update({ where: { id: email.tokenId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
  await assert.rejects(recovery.resetPassword(email.token, "New password value 123"), /invalid or expired/);
  const unchanged = await prisma!.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(await argon2.verify(unchanged.passwordHash, "Original password value"), true);
});

test("concurrent use of one verification token has exactly one winner", {
  skip: !runIntegration,
}, async () => {
  const user = await createCustomer();
  const recovery = createRecovery();
  await recovery.issueVerificationForNewUser({ id: user.id, email: user.email });
  const email = await getStagedEmail(user.id, AuthTokenPurpose.EMAIL_VERIFICATION);
  const results = await Promise.allSettled([
    recovery.verifyEmail(email.token),
    recovery.verifyEmail(email.token),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(await prisma!.authToken.count({ where: { userId: user.id, purpose: AuthTokenPurpose.EMAIL_VERIFICATION, consumedAt: { not: null } } }), 1);
});

test("password-reset request is generic for existing and nonexistent addresses", {
  skip: !runIntegration,
}, async () => {
  const user = await createCustomer("ACTIVE");
  const recovery = createRecovery();
  const existingResponse = await recovery.requestPasswordReset(user.email);
  const unknownResponse = await recovery.requestPasswordReset(`${prefix}-unknown@example.test`);
  assert.equal(existingResponse, undefined);
  assert.equal(unknownResponse, undefined);
  assert.equal(await getStagedEmailCount(user.id, AuthTokenPurpose.PASSWORD_RESET), 1);
});
