import { prisma } from "../../config/prisma.js";
import type { NotificationType } from "../../generated/prisma/client.js";
import { logger } from "../../utils/logger.js";

export async function createNotification(data: {
  userId: string;
  deliveryId?: string;
  type: NotificationType;
  title: string;
  message: string;
}) {
  return prisma.notification.create({
    data: {
      userId: data.userId,
      deliveryId: data.deliveryId,
      type: data.type,
      title: data.title,
      message: data.message,
    },
  });
}

export async function createNotificationsBestEffort(
  notifications: Array<{
    userId: string;
    deliveryId: string;
    type: NotificationType;
    title: string;
    message: string;
  }>,
) {
  const results = await Promise.allSettled(
    notifications.map((notification) => createNotification(notification)),
  );
  const failedCount = results.filter((result) => result.status === "rejected").length;

  if (failedCount > 0) {
    logger.warn("notification_persistence_failed", { failedCount });
  }
}

export async function getNotifications(
  userId: string,
  page: number,
  limit: number,
  unreadOnly: boolean,
) {
  const where = {
    userId,
    ...(unreadOnly ? { isRead: false } : {}),
  };

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.notification.count({ where }),
  ]);

  return {
    notifications,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1,
    },
  };
}

export async function getUnreadCount(userId: string) {
  return prisma.notification.count({
    where: {
      userId,
      isRead: false,
    },
  });
}

export async function markAsRead(userId: string, id: string) {
  const notification = await prisma.notification.findFirst({
    where: {
      id,
      userId,
    },
  });

  if (!notification) {
    return null;
  }

  if (notification.isRead) {
    return notification;
  }

  return prisma.notification.update({
    where: { id },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });
}

export async function markAllAsRead(userId: string) {
  const result = await prisma.notification.updateMany({
    where: {
      userId,
      isRead: false,
    },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });

  return { updatedCount: result.count };
}
