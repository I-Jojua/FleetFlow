import { Router } from "express";

import * as controller from "./delivery.controller";

import { authenticate } from "./../auth/auth.middleware";

import { authorizeRoles } from "./../auth/role.middleware";

const router = Router();

// Public tracking
router.get(
  "/track/:trackingCode",
  controller.trackDelivery,
);

// Authentication
router.use(authenticate);

// Create delivery
router.post(
  "/",
  authorizeRoles("CUSTOMER", "ADMIN", "SUPER_ADMIN"),
  controller.createDelivery,
);

// Customer deliveries
router.get(
  "/my",
  authorizeRoles("CUSTOMER"),
  controller.getMyDeliveries,
);

// Search deliveries
router.get(
  "/",
  authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  controller.searchDeliveries,
);

// Driver assigned deliveries
router.get(
  "/assigned",
  authorizeRoles("DRIVER"),
  controller.getMyAssignedDeliveries,
);

// Delivery statistics
router.get(
  "/statistics",
  authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  controller.getDeliveryStatistics,
);

// Assign driver
router.patch(
  "/:id/assign",
  authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  controller.assignDriver,
);

// Update delivery status
router.patch(
  "/:id/status",
  authorizeRoles(
    "DRIVER",
    "ADMIN",
    "SUPER_ADMIN",
    "DISPATCHER",
  ),
  controller.updateDeliveryStatus,
);

// Update driver GPS location
router.patch(
  "/:id/location",
  authorizeRoles("DRIVER"),
  controller.updateMyLocation,
);

// Get driver's latest GPS location
router.get(
  "/:id/location",
  controller.getDriverLocation,
);

// Get delivery
router.get("/:id", controller.getDelivery);

export default router;