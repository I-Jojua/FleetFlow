import type { Request, Response, NextFunction } from "express";
import * as deliveryService from "./delivery.service.js";
import {
  createDeliverySchema,
  assignDriverSchema,
  updateDeliveryStatusSchema,
  deliveryQuerySchema,
  updateDriverLocationSchema,
  locationHistoryQuerySchema,
} from "./delivery.validation.js";
import { validateUuidParam } from "../../middleware/request-validation.js";
import { isStaffRole } from "../auth/authorization.js";
import { validateIdempotencyKey } from "../idempotency/idempotency.service.js";

// --- დამხმარე ფუნქციები (Helpers) ---

function validateDeliveryId(req: Request, res: Response): string | null {
  return validateUuidParam(req, res, "Delivery");
}

function readIdempotencyKey(req: Request, res: Response): string | undefined | null {
  const key = typeof req.get === "function" ? req.get("Idempotency-Key") : undefined;
  if (key === undefined) return undefined;
  if (!validateIdempotencyKey(key)) {
    res.status(400).json({
      success: false,
      code: "INVALID_IDEMPOTENCY_KEY",
      message: "Idempotency-Key must be 8–128 characters using letters, digits, dot, underscore, colon, or dash.",
    });
    return null;
  }
  return key;
}

// --- კონტროლერები ---

export async function createDelivery(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const idempotencyKey = readIdempotencyKey(req, res);
    if (idempotencyKey === null) return;
    const data = createDeliverySchema.parse(req.body);
    const user = req.user!;
    const isStaff = isStaffRole(user.role);

    if (!isStaff && user.role !== "CUSTOMER") {
      return res.status(403).json({
        success: false,
        code: "FORBIDDEN",
        message: "You are not allowed to create a delivery.",
      });
    }

    if (isStaff && !data.customerId) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_FAILED",
        message: "customerId is required when staff creates a delivery.",
      });
    }

    if (user.role === "CUSTOMER" && data.customerId && data.customerId !== user.id) {
      return res.status(403).json({
        success: false,
        code: "FORBIDDEN",
        message: "A customer can only create deliveries for their own account.",
      });
    }

    const customerId = user.role === "CUSTOMER" ? user.id : data.customerId!;

    const delivery = await deliveryService.createDelivery(customerId, data, user.id, user.role, idempotencyKey);

    return res.status(201).json({
      success: true,
      message: "Delivery created successfully",
      data: delivery,
    });
  } catch (error) {
    next(error);
  }
}

export async function getMyDeliveries(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const deliveries = await deliveryService.getCustomerDeliveries(
      req.user!.id,
    );

    return res.status(200).json({
      success: true,
      data: deliveries,
    });
  } catch (error) {
    next(error);
  }
}

export async function getDelivery(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const deliveryId = validateDeliveryId(req, res);
    if (!deliveryId) return;

    const delivery = await deliveryService.getDeliveryByIdForActor(deliveryId, req.user!);

    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: "Delivery not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: delivery,
    });
  } catch (error) {
    next(error);
  }
}

export async function assignDriver(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const deliveryId = validateDeliveryId(req, res);
    if (!deliveryId) return;

    const idempotencyKey = readIdempotencyKey(req, res);
    if (idempotencyKey === null) return;

    if (!isStaffRole(req.user!.role)) {
      return res.status(403).json({
        success: false,
        code: "FORBIDDEN",
        message: "Only staff can assign or reassign a driver.",
      });
    }

    const { driverId } = assignDriverSchema.parse(req.body);

    const delivery = await deliveryService.assignDriver(
      deliveryId,
      driverId,
      req.user!.id,
      req.user!.role,
      idempotencyKey,
    );

    return res.status(200).json({
      success: true,
      message: "Driver assigned successfully",
      data: delivery,
    });
  } catch (error) {
    next(error);
  }
}

export async function getAllDeliveries(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const deliveries = await deliveryService.getAllDeliveries();

    return res.status(200).json({
      success: true,
      data: deliveries,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateDeliveryStatus(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const deliveryId = validateDeliveryId(req, res);
    if (!deliveryId) return;

    const { status } = updateDeliveryStatusSchema.parse(req.body);
    const user = req.user!;

    const updated = await deliveryService.updateDeliveryStatus(
      deliveryId,
      user,
      status,
    );

    return res.status(200).json({
      success: true,
      message: "Delivery status updated successfully.",
      data: updated,
    });
  } catch (error) {
    next(error);
  }
}

export async function trackDelivery(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const trackingCode = req.params.trackingCode;

    if (
      typeof trackingCode !== "string" ||
      trackingCode.trim().length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid tracking code.",
      });
    }

    const delivery = await deliveryService.trackDelivery(
      trackingCode.trim().toUpperCase(),
    );

    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: "Delivery not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: delivery,
    });
  } catch (error) {
    next(error);
  }
}

export async function getMyAssignedDeliveries(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const deliveries = await deliveryService.getDriverDeliveries(
      req.user!.id,
    );

    return res.status(200).json({
      success: true,
      count: deliveries.length,
      data: deliveries,
    });
  } catch (error) {
    next(error);
  }
}

export async function getDeliveryStatistics(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const statistics = await deliveryService.getDeliveryStatistics();

    return res.status(200).json({
      success: true,
      data: statistics,
    });
  } catch (error) {
    next(error);
  }
}

export async function searchDeliveries(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const filters = deliveryQuerySchema.parse(req.query);
    const result = await deliveryService.searchDeliveries(filters);

    return res.status(200).json({
      success: true,
      data: result.deliveries,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateMyLocation(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const deliveryId = validateDeliveryId(req, res);
    if (!deliveryId) return;

    const data = updateDriverLocationSchema.parse(req.body);

    const location = await deliveryService.updateDriverLocation(
      deliveryId,
      req.user!.id,
      data,
    );

    return res.status(201).json({
      success: true,
      message: "Driver location updated successfully.",
      data: location,
    });
  } catch (error) {
    next(error);
  }
}

export async function getDriverLocation(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const deliveryId = validateDeliveryId(req, res);
    if (!deliveryId) return;

    const delivery = await deliveryService.getDeliveryByIdForActor(deliveryId, req.user!);

    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: "Delivery not found.",
      });
    }

    const location = await deliveryService.getDriverLocation(deliveryId);

    return res.status(200).json({
      success: true,
      message: location
        ? "Driver location retrieved successfully."
        : "Driver location is not available yet.",
      data: location,
    });
  } catch (error) {
    next(error);
  }
}

export async function getDriverLocationHistory(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const deliveryId = validateDeliveryId(req, res);
    if (!deliveryId) return;

    const parsedPagination = locationHistoryQuerySchema.safeParse(req.query);
    if (!parsedPagination.success) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_FAILED",
        message: "Invalid pagination parameters.",
        errors: parsedPagination.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      });
    }
    const { page, limit } = parsedPagination.data;

    const delivery = await deliveryService.getDeliveryByIdForActor(deliveryId, req.user!);

    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: "Delivery not found.",
      });
    }

    const history = await deliveryService.getDriverLocationHistory(
      deliveryId,
      page,
      limit,
    );

    return res.status(200).json({
      success: true,
      message: "Driver location history retrieved successfully.",
      data: history,
    });
  } catch (error) {
    next(error);
  }
}
