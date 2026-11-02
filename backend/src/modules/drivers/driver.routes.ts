import { Router } from "express";
import * as controller from "./driver.controller";
import { authenticate } from "../auth/auth.middleware";
import { authorizeRoles } from "../auth/role.middleware";

const router = Router();

router.use(authenticate);

router.post(
  "/",
  authorizeRoles("ADMIN", "SUPER_ADMIN"),
  controller.createDriver,
);

router.get(
  "/",
  authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  controller.getAllDrivers,
);

router.get(
  "/:id",
  authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  controller.getDriver,
);

router.patch(
  "/:id",
  authorizeRoles("ADMIN", "SUPER_ADMIN"),
  controller.updateDriver,
);

router.patch(
  "/:id/status",
  authorizeRoles("ADMIN", "SUPER_ADMIN"),
  controller.updateDriverStatus,
);

router.get(
  "/:id/statistics",
  authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  controller.getDriverStatistics,
);

export default router;
