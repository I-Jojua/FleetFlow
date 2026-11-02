
import { Router } from "express";

import {
  register,
  login,
  refresh,
  logout,
  getMe,
} from "./auth.controller.js";

import { authenticate } from "./auth.middleware.js";
import { authRateLimiters } from "../../middleware/rate-limit.middleware.js";

const router = Router();

router.post("/register", authRateLimiters.register, register);
router.post("/login", authRateLimiters.login, login);
router.post("/refresh", authRateLimiters.refresh, refresh);
router.post("/logout", logout);

router.get("/me", authenticate, getMe);

export default router;
