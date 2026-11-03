import type { Request, Response, NextFunction } from "express";
import { validateUuidParam } from "../../middleware/request-validation.js";
import { dispatchRecommendationQuerySchema } from "./dispatch.validation.js";
import { recommendDrivers } from "./dispatch.service.js";

export async function getRecommendations(req: Request, res: Response, next: NextFunction) {
  try {
    const deliveryId = validateUuidParam(req, res, "Delivery");
    if (!deliveryId) return;
    const { limit } = dispatchRecommendationQuerySchema.parse(req.query);
    const data = await recommendDrivers(deliveryId, req.user!, limit);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}
