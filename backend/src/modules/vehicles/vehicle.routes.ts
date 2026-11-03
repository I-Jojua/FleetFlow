import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { authorizeRoles } from "../auth/role.middleware.js";
import { workforceReadRateLimiter, workforceWriteRateLimiter } from "../../middleware/rate-limit.middleware.js";
import * as controller from "./vehicle.controller.js";

const router = Router();
router.use(authenticate);
router.get("/", authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"), workforceReadRateLimiter, controller.listVehicles);
router.get("/:id", authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"), workforceReadRateLimiter, controller.getVehicle);
router.post("/", authorizeRoles("ADMIN", "SUPER_ADMIN"), workforceWriteRateLimiter, controller.createVehicle);
router.get("/:id/assignments", authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"), workforceReadRateLimiter, controller.listAssignments);
router.patch("/:id", authorizeRoles("ADMIN", "SUPER_ADMIN"), workforceWriteRateLimiter, controller.updateVehicle);
router.patch("/:id/status", authorizeRoles("ADMIN", "SUPER_ADMIN"), workforceWriteRateLimiter, controller.updateVehicleStatus);
router.put("/:id/assignment", authorizeRoles("ADMIN", "SUPER_ADMIN"), workforceWriteRateLimiter, controller.assignVehicle);
router.delete("/:id/assignment", authorizeRoles("ADMIN", "SUPER_ADMIN"), workforceWriteRateLimiter, controller.unassignVehicle);
export default router;
