import { Router } from "express";
import * as controller from "./delivery.controller";
import { authenticate } from "./../auth/auth.middleware";
import { authorizeRoles } from "./../auth/role.middleware";
import {
  publicTrackingRateLimiter,
  driverLocationUpdateRateLimiter,
  locationReadRateLimiter,
  workforceWriteRateLimiter,
} from "../../middleware/rate-limit.middleware.js";

const router = Router();

// Public tracking
router.get(
  "/track/:trackingCode",
  publicTrackingRateLimiter,
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

router.patch(
  "/:id/requirements",
  authorizeRoles("ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  workforceWriteRateLimiter,
  controller.updateDeliveryRequirements,
);

// Update delivery status
router.patch(
  "/:id/status",
  authorizeRoles("CUSTOMER", "DRIVER", "ADMIN", "SUPER_ADMIN", "DISPATCHER"),
  controller.updateDeliveryStatus,
);

// Update driver GPS location
router.patch(
  "/:id/location",
  authorizeRoles("DRIVER"),
  driverLocationUpdateRateLimiter,
  controller.updateMyLocation,
);

// Get driver's latest GPS location
router.get(
  "/:id/location",
  locationReadRateLimiter,
  controller.getDriverLocation,
);

// Get driver's GPS location history
router.get(
  "/:id/location/history",
  locationReadRateLimiter,
  controller.getDriverLocationHistory,
);

// Get delivery
router.get(
  "/:id",
  controller.getDelivery,
);

export default router;
