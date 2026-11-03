import type { Request, Response, NextFunction } from "express";
import { issueRealtimeTicket } from "./ticket.service.js";

export async function createRealtimeTicket(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await issueRealtimeTicket(req.user!.id);
    return res.status(201).json({
      success: true,
      message: "Realtime connection ticket created.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
