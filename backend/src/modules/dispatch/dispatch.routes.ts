import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { authorizeRoles } from "../auth/role.middleware.js";
import { dispatchRecommendationsRateLimiter } from "../../middleware/rate-limit.middleware.js";
import { getRecommendations } from "./dispatch.controller.js";

const router = Router();
router.use(authenticate);
router.get(
  "/deliveries/:id/recommendations",
  authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  dispatchRecommendationsRateLimiter,
  getRecommendations,
);

export default router;
