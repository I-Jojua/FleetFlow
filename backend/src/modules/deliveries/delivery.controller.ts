import type { Request, Response, NextFunction } from "express";
import * as deliveryService from "./delivery.service.js";
import {
  createDeliverySchema,
  assignDriverSchema,
  updateDeliveryStatusSchema,
  deliveryQuerySchema,
  updateDriverLocationSchema,
} from "./delivery.validation.js";

// --- დამხმარე ფუნქციები (Helpers) ---

const STAFF_ROLES = ["SUPER_ADMIN", "ADMIN", "DISPATCHER"];

function isStaffMember(role: string): boolean {
  return STAFF_ROLES.includes(role);
}

function validateDeliveryId(req: Request, res: Response): string | null {
  const deliveryId = req.params.id;
  if (typeof deliveryId !== "string" || deliveryId.trim().length === 0) {
    res.status(400).json({
      success: false,
      message: "Invalid delivery ID.",
    });
    return null;
  }
  return deliveryId;
}

// --- კონტროლერები ---

export async function createDelivery(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = createDeliverySchema.parse(req.body);
    const customerId = req.user!.id;

    const delivery = await deliveryService.createDelivery(customerId, data);

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

    const delivery = await deliveryService.getDeliveryById(deliveryId);

    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: "Delivery not found",
      });
    }

    const user = req.user!;
    const hasAccess =
      isStaffMember(user.role) ||
      delivery.customerId === user.id ||
      delivery.driverId === user.id;

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
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

    const { driverId } = assignDriverSchema.parse(req.body);

    const delivery = await deliveryService.assignDriver(
      deliveryId,
      driverId,
      req.user!.id,
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

    const delivery = await deliveryService.getDeliveryById(deliveryId);

    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: "Delivery not found.",
      });
    }

    const isStaff = isStaffMember(user.role);
    const isAssignedDriver =
      user.role === "DRIVER" && delivery.driverId === user.id;

    if (!isStaff && !isAssignedDriver) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to update this delivery.",
      });
    }

    const updated = await deliveryService.updateDeliveryStatus(
      deliveryId,
      user.id,
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

    const user = req.user!;
    const delivery = await deliveryService.getDeliveryById(deliveryId);

    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: "Delivery not found.",
      });
    }

    const hasAccess =
      isStaffMember(user.role) ||
      delivery.customerId === user.id ||
      delivery.driverId === user.id;

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
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

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit) || 50),
    );

    const delivery = await deliveryService.getDeliveryById(deliveryId);

    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: "Delivery not found.",
      });
    }

    const user = req.user!;
    const isStaff = isStaffMember(user.role);
    const isCustomer = delivery.customerId === user.id;
    const isAssignedDriver = delivery.driverId === user.id;

    if (!isStaff && !isCustomer && !isAssignedDriver) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to view this location history.",
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