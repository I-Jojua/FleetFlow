import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { authorizeRoles } from "../auth/role.middleware.js";
import { auditReadRateLimiter } from "../../middleware/rate-limit.middleware.js";
import { getAuditLogs } from "./audit.controller.js";

const router = Router();
router.use(authenticate);
router.use(authorizeRoles("ADMIN", "SUPER_ADMIN"));
router.get("/", auditReadRateLimiter, getAuditLogs);

export default router;
