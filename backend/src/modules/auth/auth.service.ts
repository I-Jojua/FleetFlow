
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "node:crypto";

import { prisma } from "../../config/prisma.js";
import { env } from "../../config/env.js";

import {
  AuthError,
  type AuthTokens,
  type AuthUser,
} from "./auth.types.js";

import type {
  RegisterInput,
  LoginInput,
} from "./auth.validation.js";

import { UserStatus } from "../../generated/prisma/client.js";

const ACCESS_TOKEN_TTL = 15 * 60;
const REFRESH_TOKEN_TTL_DAYS = 7;

const hashToken = (token: string): string => {
  return createHash("sha256").update(token).digest("hex");
};

const createAccessToken = (user: {
  id: string;
  role: string;
}): string => {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
    },
    env.JWT_ACCESS_SECRET,
    {
      expiresIn: ACCESS_TOKEN_TTL,
    }
  );
};

const createRefreshToken = (): string => {
  return randomBytes(64).toString("hex");
};

const getRefreshTokenExpiry = (): Date => {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + REFRESH_TOKEN_TTL_DAYS);
  return expiry;
};

const sanitizeUser = (user: {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
}): AuthUser => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  phone: user.phone,
  role: user.role,
  status: user.status,
});

const issueTokens = async (
  user: {
    id: string;
    role: string;
  }
): Promise<AuthTokens> => {
  const accessToken = createAccessToken(user);
  const refreshToken = createRefreshToken();

  await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(refreshToken),
      userId: user.id,
      expiresAt: getRefreshTokenExpiry(),
    },
  });

  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_TTL,
  };
};

export const register = async (
  input: RegisterInput
) => {
  const existingUser = await prisma.user.findUnique({
    where: {
      email: input.email,
    },
  });

  if (existingUser) {
    throw new AuthError("Email is already registered.", 409);
  }

  if (input.phone) {
    const existingPhone = await prisma.user.findUnique({
      where: {
        phone: input.phone,
      },
    });

    if (existingPhone) {
      throw new AuthError("Phone number is already registered.", 409);
    }
  }

  const passwordHash = await argon2.hash(input.password, {
    type: argon2.argon2id,
  });

  const user = await prisma.user.create({
    data: {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      passwordHash,
      phone: input.phone,
    },
  });

  const tokens = await issueTokens(user);

  return {
    user: sanitizeUser(user),
    tokens,
  };
};

export const login = async (
  input: LoginInput
) => {
  const user = await prisma.user.findUnique({
    where: {
      email: input.email,
    },
  });

  if (!user) {
    throw new AuthError("Invalid email or password.", 401);
  }

  const passwordMatches = await argon2.verify(
    user.passwordHash,
    input.password
  );

  if (!passwordMatches) {
    throw new AuthError("Invalid email or password.", 401);
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw new AuthError("This account is not active.", 403);
  }

  await prisma.user.update({
    where: {
      id: user.id,
    },
    data: {
      lastLoginAt: new Date(),
    },
  });

  const tokens = await issueTokens(user);

  return {
    user: sanitizeUser(user),
    tokens,
  };
};

export const refresh = async (refreshToken: string) => {
  const tokenHash = hashToken(refreshToken);

  const existingToken = await prisma.refreshToken.findUnique({
    where: {
      tokenHash,
    },
    include: {
      user: true,
    },
  });

  if (!existingToken) {
    throw new AuthError("Invalid refresh token.", 401);
  }

  if (existingToken.revokedAt) {
    // Reuse detection: revoke all sessions for this user.
    await prisma.refreshToken.updateMany({
      where: {
        userId: existingToken.userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    throw new AuthError("Refresh token reuse detected. Please log in again.", 401);
  }

  if (existingToken.expiresAt <= new Date()) {
    await prisma.refreshToken.update({
      where: {
        id: existingToken.id,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    throw new AuthError("Refresh token has expired.", 401);
  }

  if (existingToken.user.status !== UserStatus.ACTIVE) {
    throw new AuthError("This account is not active.", 403);
  }

  const newRefreshToken = createRefreshToken();
  const newTokenHash = hashToken(newRefreshToken);

  const accessToken = createAccessToken(existingToken.user);

  await prisma.$transaction(async (tx) => {
    const revoked = await tx.refreshToken.updateMany({
      where: {
        id: existingToken.id,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        replacedByTokenHash: newTokenHash,
      },
    });

    if (revoked.count !== 1) {
      throw new AuthError("Refresh token has already been used.", 401);
    }

    await tx.refreshToken.create({
      data: {
        tokenHash: newTokenHash,
        userId: existingToken.userId,
        expiresAt: getRefreshTokenExpiry(),
      },
    });
  });

  return {
    accessToken,
    refreshToken: newRefreshToken,
    tokenType: "Bearer" as const,
    expiresIn: ACCESS_TOKEN_TTL,
  };
};

export const logout = async (refreshToken: string) => {
  await prisma.refreshToken.updateMany({
    where: {
      tokenHash: hashToken(refreshToken),
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });

  return {
    message: "Logged out successfully.",
  };
};


export const getMe = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      role: true,
      status: true,
      emailVerifiedAt: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  if (!user) {
    throw new AuthError("User not found.", 404);
  }

  return user;
};

