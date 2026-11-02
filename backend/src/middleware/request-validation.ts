import type { Request, Response } from "express";
import { z } from "zod";

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export function validateUuidParam(
  req: Request,
  res: Response,
  resourceLabel: string,
  paramName = "id",
): string | null {
  const parsed = z.string().uuid().safeParse(req.params[paramName]);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      code: "INVALID_IDENTIFIER",
      message: `Invalid ${resourceLabel} ID.`,
    });
    return null;
  }

  return parsed.data;
}
