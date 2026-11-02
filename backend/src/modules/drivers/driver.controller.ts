import type { Request, Response, NextFunction } from "express";
import * as driverService from "./driver.service.js";
import {
  createDriverSchema,
  updateDriverSchema,
  updateDriverStatusSchema,
  driverQuerySchema,
} from "./driver.validation.js";
import { validateUuidParam } from "../../middleware/request-validation.js";

export async function createDriver(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = createDriverSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed.",
        errors: parsed.error.flatten(),
      });
    }

    const driver = await driverService.createDriver(parsed.data);

    return res.status(201).json({
      success: true,
      message: "Driver created successfully.",
      data: driver,
    });
  } catch (error) {
    next(error);
  }
}

export async function getAllDrivers(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = driverQuerySchema.safeParse(req.query);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid query parameters.",
        errors: parsed.error.flatten(),
      });
    }

    const result = await driverService.getAllDrivers(parsed.data);

    return res.status(200).json({
      success: true,
      message: "Drivers retrieved successfully.",
      data: result.drivers,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

export async function getDriver(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = validateUuidParam(req, res, "Driver");
    if (!id) return;

    const driver = await driverService.getDriverById(id);

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Driver retrieved successfully.",
      data: driver,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateDriver(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = validateUuidParam(req, res, "Driver");
    if (!id) return;

    const parsed = updateDriverSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed.",
        errors: parsed.error.flatten(),
      });
    }

    const driver = await driverService.updateDriver(id, parsed.data);

    return res.status(200).json({
      success: true,
      message: "Driver updated successfully.",
      data: driver,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateDriverStatus(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = validateUuidParam(req, res, "Driver");
    if (!id) return;

    const parsed = updateDriverStatusSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid driver status.",
        errors: parsed.error.flatten(),
      });
    }

    const driver = await driverService.updateDriverStatus(
      id,
      parsed.data.status,
    );

    return res.status(200).json({
      success: true,
      message: "Driver status updated successfully.",
      data: driver,
    });
  } catch (error) {
    next(error);
  }
}

export async function getDriverStatistics(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = validateUuidParam(req, res, "Driver");
    if (!id) return;

    const statistics = await driverService.getDriverStatistics(id);

    return res.status(200).json({
      success: true,
      message: "Driver statistics retrieved successfully.",
      data: statistics,
    });
  } catch (error) {
    next(error);
  }
}

\n