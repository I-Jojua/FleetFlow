
import type { Request, Response } from "express";

import * as authService from "./auth.service.js";

import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
} from "./auth.validation.js";

import { AuthError } from "./auth.types.js";

const handleError = (res: Response, error: unknown) => {
  if (error instanceof AuthError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
  }

  console.error("Authentication error:", error);

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
        errors: validation.error.issues,
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
        errors: validation.error.issues,
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
