import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { authorizeRoles } from "../auth/role.middleware.js";
import { workforceReadRateLimiter, workforceWriteRateLimiter } from "../../middleware/rate-limit.middleware.js";
import * as controller from "./workforce.controller.js";

const router = Router();
router.use(authenticate);
router.patch("/:id/availability", authorizeRoles("ADMIN", "SUPER_ADMIN"), workforceWriteRateLimiter, controller.updateAvailability);
router.get("/:id/qualifications", authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"), workforceReadRateLimiter, controller.listQualifications);
router.post("/:id/qualifications", authorizeRoles("ADMIN", "SUPER_ADMIN"), workforceWriteRateLimiter, controller.createQualification);
router.patch("/:id/qualifications/:qualificationId/verification", authorizeRoles("ADMIN", "SUPER_ADMIN"), workforceWriteRateLimiter, controller.verifyQualification);
router.get("/:id/shifts", authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"), workforceReadRateLimiter, controller.listShifts);
router.post("/:id/shifts", authorizeRoles("ADMIN", "SUPER_ADMIN"), workforceWriteRateLimiter, controller.createShift);
router.patch("/:id/shifts/:shiftId", authorizeRoles("ADMIN", "SUPER_ADMIN"), workforceWriteRateLimiter, controller.updateShift);
router.patch("/:id/shifts/:shiftId/status", authorizeRoles("ADMIN", "SUPER_ADMIN"), workforceWriteRateLimiter, controller.updateShiftStatus);
export default router;
