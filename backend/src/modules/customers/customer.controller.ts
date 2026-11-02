import type { Request, Response, NextFunction } from "express";
import * as customerService from "./customer.service.js";
import {
  createCustomerSchema,
  updateCustomerSchema,
  updateCustomerStatusSchema,
  customerQuerySchema,
} from "./customer.validation.js";
import { validateUuidParam } from "../../middleware/request-validation.js";

export async function createCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createCustomerSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed.",
        errors: parsed.error.flatten(),
      });
    }

    const customer = await customerService.createCustomer(parsed.data);

    return res.status(201).json({
      success: true,
      message: "Customer created successfully.",
      data: customer,
    });
  } catch (error) {
    next(error);
  }
}

export async function getAllCustomers(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = customerQuerySchema.safeParse(req.query);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid query parameters.",
        errors: parsed.error.flatten(),
      });
    }

    const result = await customerService.getAllCustomers(parsed.data);

    return res.status(200).json({
      success: true,
      message: "Customers retrieved successfully.",
      data: result.customers,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

export async function getCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = validateUuidParam(req, res, "Customer");
    if (!id) return;

    const customer = await customerService.getCustomerById(id);

    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found." });
    }

    return res.status(200).json({
      success: true,
      message: "Customer retrieved successfully.",
      data: customer,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = validateUuidParam(req, res, "Customer");
    if (!id) return;

    const parsed = updateCustomerSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed.",
        errors: parsed.error.flatten(),
      });
    }

    const customer = await customerService.updateCustomer(id, parsed.data);

    return res.status(200).json({
      success: true,
      message: "Customer updated successfully.",
      data: customer,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateCustomerStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const id = validateUuidParam(req, res, "Customer");
    if (!id) return;

    const parsed = updateCustomerStatusSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer status.",
        errors: parsed.error.flatten(),
      });
    }

    const customer = await customerService.updateCustomerStatus(id, parsed.data.status);

    return res.status(200).json({
      success: true,
      message: "Customer status updated successfully.",
      data: customer,
    });
  } catch (error) {
    next(error);
  }
}

export async function getCustomerStatistics(req: Request, res: Response, next: NextFunction) {
  try {
    const id = validateUuidParam(req, res, "Customer");
    if (!id) return;

    const statistics = await customerService.getCustomerStatistics(id);

    return res.status(200).json({
      success: true,
      message: "Customer statistics retrieved successfully.",
      data: statistics,
    });
  } catch (error) {
    next(error);
  }
}
