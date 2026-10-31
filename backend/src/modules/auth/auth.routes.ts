
import { Router } from "express";

import {
  register,
  login,
  refresh,
  logout,
  getMe,
} from "./auth.controller.js";

import { authenticate } from "./auth.middleware.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/refresh", refresh);
router.post("/logout", logout);

router.get("/me", authenticate, getMe);

export default router;
