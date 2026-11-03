import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import { AuditOutcome, AuthTokenPurpose, UserStatus, type Prisma } from "../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { prisma } from "../../config/prisma.js";
import { logger } from "../../utils/logger.js";
import { AuthError } from "./auth.types.js";
import { encryptEmailToken } from "../email/email-crypto.js";
import { writeAuditEvent } from "../audit/audit.service.js";
import { getRequestId } from "../../observability/request-context.js";

type RecoveryDatabase = typeof prisma;

export function hashAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createRawToken(): string {
  return randomBytes(32).toString("base64url");
}

function expiryFor(purpose: AuthTokenPurpose, now: Date, settings: typeof env): Date {
  const lifetimeMinutes = purpose === AuthTokenPurpose.EMAIL_VERIFICATION
    ? settings.EMAIL_VERIFICATION_TTL_MINUTES
    : settings.PASSWORD_RESET_TTL_MINUTES;
  return new Date(now.getTime() + lifetimeMinutes * 60_000);
}

async function createTokenInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  purpose: AuthTokenPurpose,
  settings: typeof env,
  now: Date,
) {
  await tx.authToken.updateMany({
    where: { userId, purpose, consumedAt: null, invalidatedAt: null },
    data: { invalidatedAt: now },
  });
  const token = createRawToken();
  const record = await tx.authToken.create({
    data: {
      userId,
      purpose,
      tokenHash: hashAuthToken(token),
      expiresAt: expiryFor(purpose, now, settings),
    },
    select: { id: true },
  });
  return { token, tokenId: record.id };
}

export function createAuthRecoveryService(dependencies: {
  db?: RecoveryDatabase;
  settings?: typeof env;
  now?: () => Date;
  log?: typeof logger;
} = {}) {
  const db = dependencies.db ?? prisma;
  const settings = dependencies.settings ?? env;
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? logger;
  const recordRejectedToken = (action: string) => db.$transaction((tx) => writeAuditEvent(tx, {
    action,
    resourceType: "auth_token",
    outcome: AuditOutcome.FAILURE,
    metadata: { reason: "invalid_token" },
    captureIpAddress: true,
  }));

  const stageEmailOutboxEvent = async (
    tx: Prisma.TransactionClient,
    user: { id: string; email: string },
    purpose: AuthTokenPurpose,
  ): Promise<void> => {
    const encryptionKey = settings.EMAIL_TOKEN_ENCRYPTION_KEY;
    if (!encryptionKey) {
      log.error("auth_email_outbox_configuration_missing", { purpose });
      throw new AuthError("Email delivery is temporarily unavailable. Please try again.", 503);
    }
    const issued = await createTokenInTransaction(tx, user.id, purpose, settings, now());
    const requestId = getRequestId();
    await tx.outboxEvent.create({
      data: {
        eventType: "AUTH_EMAIL",
        dedupeKey: `auth-email:${issued.tokenId}`,
        requestId: requestId && requestId.length <= 100 ? requestId : null,
        payload: {
          authTokenId: issued.tokenId,
          encryptedToken: encryptEmailToken(issued.token, encryptionKey),
          template: purpose === AuthTokenPurpose.EMAIL_VERIFICATION ? "verify-email" : "password-reset",
        },
      },
    });
  };

  const issueAndStage = async (
    user: { id: string; email: string },
    purpose: AuthTokenPurpose,
  ): Promise<void> => {
    await db.$transaction((tx) => stageEmailOutboxEvent(tx, user, purpose));
  };

  return {
    async stageVerificationForNewUser(
      tx: Prisma.TransactionClient,
      user: { id: string; email: string },
    ): Promise<void> {
      await stageEmailOutboxEvent(tx, user, AuthTokenPurpose.EMAIL_VERIFICATION);
    },

    async issueVerificationForNewUser(user: { id: string; email: string }): Promise<void> {
      await issueAndStage(user, AuthTokenPurpose.EMAIL_VERIFICATION);
    },

    async resendVerification(email: string): Promise<void> {
      const user = await db.user.findUnique({
        where: { email },
        select: { id: true, email: true, emailVerifiedAt: true, status: true },
      });
      if (
        !user || user.emailVerifiedAt ||
        (user.status !== UserStatus.ACTIVE && user.status !== UserStatus.PENDING_VERIFICATION)
      ) return;
      try {
        await issueAndStage(user, AuthTokenPurpose.EMAIL_VERIFICATION);
      } catch {
        // Keep the public response indistinguishable for existing and unknown addresses.
      }
    },

    async verifyEmail(token: string): Promise<void> {
      const tokenHash = hashAuthToken(token);
      try {
        await db.$transaction(async (tx) => {
          const currentTime = now();
          const consumed = await tx.authToken.updateMany({
            where: {
              tokenHash,
              purpose: AuthTokenPurpose.EMAIL_VERIFICATION,
              expiresAt: { gt: currentTime },
              consumedAt: null,
              invalidatedAt: null,
            },
            data: { consumedAt: currentTime },
          });
          if (consumed.count !== 1) throw new AuthError("Verification token is invalid or expired.", 400);

          const record = await tx.authToken.findUnique({
            where: { tokenHash },
            select: { userId: true, user: { select: { role: true } } },
          });
          if (!record) throw new AuthError("Verification token is invalid or expired.", 400);

          const updated = await tx.user.updateMany({
            where: {
              id: record.userId,
              emailVerifiedAt: null,
              status: { in: [UserStatus.ACTIVE, UserStatus.PENDING_VERIFICATION] },
            },
            data: { emailVerifiedAt: currentTime, status: UserStatus.ACTIVE },
          });
          if (updated.count !== 1) throw new AuthError("Verification token is invalid or expired.", 400);
          await tx.authToken.updateMany({
            where: {
              userId: record.userId,
              purpose: AuthTokenPurpose.EMAIL_VERIFICATION,
              consumedAt: null,
              invalidatedAt: null,
            },
            data: { invalidatedAt: currentTime },
          });
          await writeAuditEvent(tx, {
            actor: { userId: record.userId, role: record.user.role },
            action: "auth.email.verify",
            resourceType: "user",
            resourceId: record.userId,
            outcome: AuditOutcome.SUCCESS,
            metadata: { reason: "verification_completed", newStatus: UserStatus.ACTIVE },
            captureIpAddress: true,
          });
        });
      } catch (error) {
        if (error instanceof AuthError && error.statusCode === 400) {
          await recordRejectedToken("auth.email.verify");
        }
        throw error;
      }
    },

    async requestPasswordReset(email: string): Promise<void> {
      const user = await db.user.findUnique({
        where: { email },
        select: { id: true, email: true, status: true, passwordHash: true },
      });
      if (!user || user.status !== UserStatus.ACTIVE || !user.passwordHash) return;
      try {
        await issueAndStage(user, AuthTokenPurpose.PASSWORD_RESET);
      } catch {
        // Always return the same public response regardless of account/provider state.
      }
    },

    async resetPassword(token: string, password: string): Promise<void> {
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
      const tokenHash = hashAuthToken(token);
      try {
        await db.$transaction(async (tx) => {
        const currentTime = now();
        const consumed = await tx.authToken.updateMany({
          where: {
            tokenHash,
            purpose: AuthTokenPurpose.PASSWORD_RESET,
            expiresAt: { gt: currentTime },
            consumedAt: null,
            invalidatedAt: null,
          },
          data: { consumedAt: currentTime },
        });
        if (consumed.count !== 1) throw new AuthError("Reset token is invalid or expired.", 400);

        const record = await tx.authToken.findUnique({
          where: { tokenHash },
          select: { userId: true, user: { select: { role: true } } },
        });
        if (!record) throw new AuthError("Reset token is invalid or expired.", 400);

        await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
        await tx.refreshToken.updateMany({
          where: { userId: record.userId, revokedAt: null },
          data: { revokedAt: currentTime },
        });
        await tx.authToken.updateMany({
          where: {
            userId: record.userId,
            purpose: AuthTokenPurpose.PASSWORD_RESET,
            consumedAt: null,
            invalidatedAt: null,
          },
          data: { invalidatedAt: currentTime },
        });
        await writeAuditEvent(tx, {
          actor: { userId: record.userId, role: record.user.role },
          action: "auth.password_reset",
          resourceType: "user",
          resourceId: record.userId,
          outcome: AuditOutcome.SUCCESS,
          metadata: { reason: "password_reset_completed" },
          captureIpAddress: true,
        });
        });
      } catch (error) {
        if (error instanceof AuthError && error.statusCode === 400) {
          await recordRejectedToken("auth.password_reset");
        }
        throw error;
      }
    },
  };
}

const authRecoveryService = createAuthRecoveryService();
export const issueVerificationForNewUser = authRecoveryService.issueVerificationForNewUser;
export const stageVerificationForNewUser = authRecoveryService.stageVerificationForNewUser;
export const resendVerification = authRecoveryService.resendVerification;
export const verifyEmail = authRecoveryService.verifyEmail;
export const requestPasswordReset = authRecoveryService.requestPasswordReset;
export const resetPassword = authRecoveryService.resetPassword;
