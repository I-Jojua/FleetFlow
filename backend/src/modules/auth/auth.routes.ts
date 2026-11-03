
import { Router } from "express";

import {
  register,
  login,
  refresh,
  logout,
  getMe,
  verifyEmail,
  resendVerification,
  requestPasswordReset,
  confirmPasswordReset,
} from "./auth.controller.js";

import { authenticate } from "./auth.middleware.js";
import { authRateLimiters } from "../../middleware/rate-limit.middleware.js";

const router = Router();

router.post("/register", authRateLimiters.register, register);
router.post("/login", authRateLimiters.login, login);
router.post("/refresh", authRateLimiters.refresh, refresh);
router.post("/logout", logout);
router.post("/verify-email", authRateLimiters.verifyEmail, verifyEmail);
router.post("/resend-verification", authRateLimiters.resendVerification, resendVerification);
router.post("/password-reset/request", authRateLimiters.passwordResetRequest, requestPasswordReset);
router.post("/password-reset/confirm", authRateLimiters.passwordResetConfirm, confirmPasswordReset);

router.get("/me", authenticate, getMe);

export default router;
