import { Router } from "express";
import * as controller from "./customer.controller";
import { authenticate } from "../auth/auth.middleware";
import { authorizeRoles } from "../auth/role.middleware";

const router = Router();

router.use(authenticate);

router.post(
  "/",
  authorizeRoles("ADMIN", "SUPER_ADMIN"),
  controller.createCustomer,
);

router.get(
  "/",
  authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  controller.getAllCustomers,
);

router.get(
  "/:id",
  authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  controller.getCustomer,
);

router.patch(
  "/:id",
  authorizeRoles("ADMIN", "SUPER_ADMIN"),
  controller.updateCustomer,
);

router.patch(
  "/:id/status",
  authorizeRoles("ADMIN", "SUPER_ADMIN"),
  controller.updateCustomerStatus,
);

router.get(
  "/:id/statistics",
  authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  controller.getCustomerStatistics,
);

export default router;
