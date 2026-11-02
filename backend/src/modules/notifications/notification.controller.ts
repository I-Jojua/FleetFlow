import type { Request, Response, NextFunction } from "express";
import * as notificationService from "./notification.service.js";
import { notificationQuerySchema } from "./notification.validation.js";
import { validateUuidParam } from "../../middleware/request-validation.js";

export async function getNotifications(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = notificationQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: "VALIDATION_FAILED",
        message: "Invalid notification query parameters.",
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      });
      return;
    }

    const result = await notificationService.getNotifications(
      req.user!.id,
      parsed.data.page,
      parsed.data.limit,
      parsed.data.unreadOnly,
    );

    res.json({
      success: true,
      message: "Notifications retrieved successfully.",
      data: result.notifications,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

export async function getUnreadCount(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const count = await notificationService.getUnreadCount(req.user!.id);

    res.json({
      success: true,
      message: "Unread notification count retrieved successfully.",
      data: { unreadCount: count },
    });
  } catch (error) {
    next(error);
  }
}

export async function markAsRead(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = validateUuidParam(req, res, "Notification");
    if (!id) return;

    const notification = await notificationService.markAsRead(
      req.user!.id,
      id,
    );

    if (!notification) {
      res.status(404).json({
        success: false,
        message: "Notification not found.",
      });
      return;
    }

    res.json({
      success: true,
      message: "Notification marked as read.",
      data: notification,
    });
  } catch (error) {
    next(error);
  }
}

export async function markAllAsRead(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await notificationService.markAllAsRead(req.user!.id);

    res.json({
      success: true,
      message: "All notifications marked as read.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
