
import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";

import { prisma } from "../../config/prisma.js";
import { env } from "../../config/env.js";
import { UserStatus } from "../../generated/prisma/client.js";
import { logger } from "../../utils/logger.js";

export const authenticate: RequestHandler = async (req, res, next): Promise<void> => {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
    return;
  }

  const token = authorization.slice(7);

  let decoded: string | jwt.JwtPayload;

  try {
    decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch {
    res.status(401).json({
      success: false,
      message: "Invalid or expired access token.",
    });
    return;
  }

  if (typeof decoded === "string" || typeof decoded.sub !== "string") {
    res.status(401).json({
      success: false,
      message: "Invalid access token payload.",
    });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: {
        id: decoded.sub,
      },
      select: {
        id: true,
        role: true,
        status: true,
      },
    });

    if (!user) {
      res.status(401).json({
        success: false,
        message: "User not found.",
      });
      return;
    }

    if (user.status !== UserStatus.ACTIVE) {
      res.status(403).json({
        success: false,
        message: "Your account is not active.",
      });
      return;
    }

    req.user = {
      id: user.id,
      role: user.role,
    };

    next();
  } catch {
    logger.error("authentication_middleware_failed", {
      requestId: typeof res.locals?.requestId === "string" ? res.locals.requestId : undefined,
    });

    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
