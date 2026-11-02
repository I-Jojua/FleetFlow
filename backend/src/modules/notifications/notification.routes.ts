import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
} from "./notification.controller.js";

const router = Router();

router.use(authenticate);

router.get("/unread-count", getUnreadCount);
router.patch("/read-all", markAllAsRead);
router.get("/", getNotifications);
router.patch("/:id/read", markAsRead);

export default router;
