import type { Request, Response, NextFunction } from "express";
import { auditLogQuerySchema } from "./audit.validation.js";
import { listAuditLogs } from "./audit.service.js";

export async function getAuditLogs(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  const parsed = auditLogQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Invalid audit log filters.",
      errors: parsed.error.flatten(),
    });
    return;
  }

  try {
    const result = await listAuditLogs(parsed.data);
    res.status(200).json({
      success: true,
      message: "Audit logs retrieved successfully.",
      data: result.records,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}
