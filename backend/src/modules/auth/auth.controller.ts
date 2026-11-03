
import type { Request, Response } from "express";

import * as authService from "./auth.service.js";

import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  emailTokenSchema,
  emailAddressSchema,
  passwordResetSchema,
} from "./auth.validation.js";

import { AuthError } from "./auth.types.js";
import { logger } from "../../utils/logger.js";
import * as authRecoveryService from "./auth-recovery.service.js";

const safeValidationErrors = (issues: Array<{ path: PropertyKey[]; message: string }>) =>
  issues.map((issue) => ({
    path: issue.path.map(String),
    message: issue.message,
  }));

const handleError = (res: Response, error: unknown) => {
  if (error instanceof AuthError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
  }

  logger.error("authentication_request_failed", {
    requestId: typeof res.locals?.requestId === "string" ? res.locals.requestId : undefined,
  });

  return res.status(500).json({
    success: false,
    message: "Internal server error.",
  });
};

export const register = async (req: Request, res: Response) => {
  try {
    const validation = registerSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed.",
        errors: safeValidationErrors(validation.error.issues),
      });
    }

    const result = await authService.register(validation.data);

    return res.status(201).json({
      success: true,
      message: "Account created successfully.",
      data: result,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const validation = loginSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed.",
        errors: safeValidationErrors(validation.error.issues),
      });
    }

    const result = await authService.login(validation.data);

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      data: result,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

export const refresh = async (req: Request, res: Response) => {
  try {
    const validation = refreshSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Refresh token is required.",
      });
    }

    const tokens = await authService.refresh(
      validation.data.refreshToken
    );

    return res.status(200).json({
      success: true,
      message: "Tokens refreshed successfully.",
      data: tokens,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

export const logout = async (req: Request, res: Response) => {
  try {
    const validation = logoutSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Refresh token is required.",
      });
    }

    const result = await authService.logout(
      validation.data.refreshToken
    );

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

export const getMe = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const user = await authService.getMe(req.user.id);

    return res.status(200).json({
      success: true,
      message: "User profile retrieved successfully.",
      data: user,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

export const verifyEmail = async (req: Request, res: Response) => {
  try {
    const validation = emailTokenSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Verification token is required.",
        errors: safeValidationErrors(validation.error.issues),
      });
    }
    await authRecoveryService.verifyEmail(validation.data.token);
    return res.status(200).json({
      success: true,
      message: "Email verified successfully.",
    });
  } catch (error) {
    return handleError(res, error);
  }
};

export const resendVerification = async (req: Request, res: Response) => {
  const validation = emailAddressSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: safeValidationErrors(validation.error.issues),
    });
  }
  try {
    await authRecoveryService.resendVerification(validation.data.email);
  } catch {
    // Do not expose whether an account exists or whether email infrastructure is available.
  }
  return res.status(202).json({
    success: true,
    message: "If the account needs verification, an email will be sent shortly.",
  });
};

export const requestPasswordReset = async (req: Request, res: Response) => {
  const validation = emailAddressSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: safeValidationErrors(validation.error.issues),
    });
  }
  try {
    await authRecoveryService.requestPasswordReset(validation.data.email);
  } catch {
    // Keep the public response indistinguishable for existing and unknown accounts.
  }
  return res.status(202).json({
    success: true,
    message: "If the account exists, a password reset email will be sent shortly.",
  });
};

export const confirmPasswordReset = async (req: Request, res: Response) => {
  const validation = passwordResetSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: safeValidationErrors(validation.error.issues),
    });
  }
  try {
    await authRecoveryService.resetPassword(validation.data.token, validation.data.password);
    return res.status(200).json({
      success: true,
      message: "Password reset successfully. Please sign in again.",
    });
  } catch (error) {
    return handleError(res, error);
  }
};
