
import { randomBytes } from "node:crypto";
import type { UserRole } from "../../generated/prisma/client";
import { prisma } from "../../config/prisma";
import { createNotificationsBestEffort } from "../notifications/notification.service";
import { sendSlackAlertBestEffort } from "../notifications/slack.service";
import type {
  CreateDeliveryInput,
} from "./delivery.validation";

function generateTrackingCode(): string {
  return `FF-${randomBytes(6).toString("hex").toUpperCase()}`;
}

export async function createDelivery(
  customerId: string,
  data: CreateDeliveryInput,
  actorId = customerId,
) {
  const delivery = await prisma.$transaction(async (tx) => {
    const customer = await tx.user.findFirst({
      where: {
        id: customerId,
        role: "CUSTOMER",
        status: "ACTIVE",
      },
      select: { id: true },
    });

    if (!customer) {
      throw new Error("CUSTOMER_NOT_FOUND");
    }

    const delivery = await tx.delivery.create({
      data: {
        trackingCode: generateTrackingCode(),
        customerId,
        recipientName: data.recipientName,
        recipientPhone: data.recipientPhone,
        pickupAddress: data.pickupAddress,
        pickupLatitude: data.pickupLatitude,
        pickupLongitude: data.pickupLongitude,
        deliveryAddress: data.deliveryAddress,
        deliveryLatitude: data.deliveryLatitude,
        deliveryLongitude: data.deliveryLongitude,
        packageDescription: data.packageDescription,
        packageWeight: data.packageWeight,
        notes: data.notes,
      },
    });

    await tx.deliveryEvent.create({
      data: {
        deliveryId: delivery.id,
        actorId,
        status: "PENDING",
        description: "Delivery order created",
      },
    });

    return delivery;
  });

  await Promise.all([
    createNotificationsBestEffort([{
      userId: customerId,
      deliveryId: delivery.id,
      type: "DELIVERY_UPDATE",
      title: "Delivery created",
      message: `Your delivery ${delivery.trackingCode} has been created.`,
    }]),
    sendSlackAlertBestEffort(
      "delivery_created",
      `New delivery created: ${delivery.trackingCode}`,
    ),
  ]);

  return delivery;
}

export async function getCustomerDeliveries(customerId: string) {
  return prisma.delivery.findMany({
    where: { customerId },
    include: {
      events: {
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getDeliveryById(id: string) {
  return prisma.delivery.findUnique({
    where: { id },
    include: {
      customer: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
      driver: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
        },
      },
      events: {
        orderBy: { createdAt: "desc" },
      },
    },
  });
}

export async function assignDriver(
  deliveryId: string,
  driverId: string,
  actorId: string,
  actorRole: UserRole,
) {
  if (!["ADMIN", "SUPER_ADMIN", "DISPATCHER"].includes(actorRole)) {
    throw new Error("DELIVERY_FORBIDDEN");
  }

  const result = await prisma.$transaction(async (tx) => {
    const delivery = await tx.delivery.findUnique({
      where: { id: deliveryId },
    });

    if (!delivery) {
      throw new Error("DELIVERY_NOT_FOUND");
    }

    if (
      delivery.status !== "PENDING" &&
      delivery.status !== "ASSIGNED"
    ) {
      throw new Error("DELIVERY_CANNOT_BE_ASSIGNED");
    }

    const driver = await tx.user.findFirst({
      where: {
        id: driverId,
        role: "DRIVER",
        status: "ACTIVE",
      },
    });

    if (!driver) {
      throw new Error("DRIVER_NOT_FOUND_OR_INACTIVE");
    }

    if (delivery.status === "ASSIGNED" && delivery.driverId === driverId) {
      return {
        delivery,
        customerId: delivery.customerId,
        driverId: driver.id,
        previousDriverId: null,
        trackingCode: delivery.trackingCode,
        changed: false,
      };
    }

    const assignment = await tx.delivery.updateMany({
      where: {
        id: deliveryId,
        status: delivery.status,
        driverId: delivery.driverId,
      },
      data: {
        driverId,
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });

    if (assignment.count !== 1) {
      throw new Error("DELIVERY_STATE_CONFLICT");
    }

    const updated = await tx.delivery.findUnique({
      where: { id: deliveryId },
    });

    if (!updated) {
      throw new Error("DELIVERY_NOT_FOUND");
    }

    await tx.deliveryEvent.create({
      data: {
        deliveryId,
        actorId,
        status: "ASSIGNED",
        description: `Driver assigned: ${driver.firstName} ${driver.lastName}`,
      },
    });

    return {
      delivery: updated,
      customerId: delivery.customerId,
      driverId: driver.id,
      previousDriverId:
        delivery.driverId && delivery.driverId !== driver.id
          ? delivery.driverId
          : null,
      trackingCode: delivery.trackingCode,
      changed: true,
    };
  }, { isolationLevel: "Serializable" });

  if (!result.changed) return result.delivery;

  const assignmentNotifications = [
    {
      userId: result.customerId,
      deliveryId: result.delivery.id,
      type: "DELIVERY_UPDATE" as const,
      title: "Driver assigned",
      message: `A driver has been assigned to delivery ${result.trackingCode}.`,
    },
    {
      userId: result.driverId,
      deliveryId: result.delivery.id,
      type: "DELIVERY_UPDATE" as const,
      title: "Delivery assigned to you",
      message: `You have been assigned delivery ${result.trackingCode}.`,
    },
  ];

  if (result.previousDriverId) {
    assignmentNotifications.push({
      userId: result.previousDriverId,
      deliveryId: result.delivery.id,
      type: "DELIVERY_UPDATE",
      title: "Delivery reassigned",
      message: `Delivery ${result.trackingCode} has been reassigned to another driver.`,
    });
  }

  await Promise.all([
    createNotificationsBestEffort(assignmentNotifications),
    sendSlackAlertBestEffort(
      "driver_assigned",
      `Driver assigned to delivery ${result.trackingCode}`,
    ),
  ]);

  return result.delivery;
}

export async function getAllDeliveries() {
  return prisma.delivery.findMany({
    include: {
      customer: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      driver: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateDeliveryStatus(
  deliveryId: string,
  actor: { id: string; role: UserRole },
  newStatus: "PICKED_UP" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED",
) {
  const result = await prisma.$transaction(async (tx) => {
    const delivery = await tx.delivery.findUnique({
      where: { id: deliveryId },
    });

    if (!delivery) {
      throw new Error("DELIVERY_NOT_FOUND");
    }

    const staffRoles: UserRole[] = ["ADMIN", "SUPER_ADMIN", "DISPATCHER"];
    const isStaff = staffRoles.includes(actor.role);
    const isAssignedDriver =
      actor.role === "DRIVER" && delivery.driverId === actor.id;
    const isCustomerCancellingOwnPendingDelivery =
      actor.role === "CUSTOMER" &&
      delivery.customerId === actor.id &&
      delivery.status === "PENDING" &&
      newStatus === "CANCELLED";

    if (!isStaff && !isAssignedDriver && !isCustomerCancellingOwnPendingDelivery) {
      throw new Error("DELIVERY_FORBIDDEN");
    }

    const allowedTransitions: Record<string, string[]> = {
      PENDING: ["CANCELLED"],
      ASSIGNED: ["PICKED_UP", "CANCELLED"],
      PICKED_UP: ["IN_TRANSIT"],
      IN_TRANSIT: ["DELIVERED"],
    };

    if (!allowedTransitions[delivery.status]?.includes(newStatus)) {
      throw new Error("INVALID_STATUS_TRANSITION");
    }

    const updateResult = await tx.delivery.updateMany({
      where: {
        id: deliveryId,
        status: delivery.status,
        driverId: delivery.driverId,
      },
      data: {
        status: newStatus,
        ...(newStatus === "PICKED_UP" && {
          pickedUpAt: new Date(),
        }),
        ...(newStatus === "DELIVERED" && {
          deliveredAt: new Date(),
        }),
      },
    });

    if (updateResult.count !== 1) {
      throw new Error("DELIVERY_STATE_CONFLICT");
    }

    const updated = await tx.delivery.findUnique({
      where: { id: deliveryId },
    });

    if (!updated) {
      throw new Error("DELIVERY_NOT_FOUND");
    }

    await tx.deliveryEvent.create({
      data: {
        deliveryId,
        actorId: actor.id,
        status: newStatus,
        description: `Delivery status changed to ${newStatus}`,
      },
    });

    return {
      delivery: updated,
      customerId: delivery.customerId,
      driverId: delivery.driverId,
      trackingCode: delivery.trackingCode,
    };
  }, { isolationLevel: "Serializable" });

  const statusLabel = newStatus.toLowerCase().replaceAll("_", " ");
  const recipients = [result.customerId, result.driverId].filter(
    (userId): userId is string => userId !== null,
  );

  await Promise.all([
    createNotificationsBestEffort(
      recipients.map((userId) => ({
        userId,
        deliveryId: result.delivery.id,
        type: "DELIVERY_UPDATE" as const,
        title: "Delivery status updated",
        message: `Delivery ${result.trackingCode} is now ${statusLabel}.`,
      })),
    ),
    sendSlackAlertBestEffort(
      "delivery_status_updated",
      `Delivery ${result.trackingCode} status updated: ${statusLabel}`,
    ),
  ]);

  return result.delivery;
}

export async function trackDelivery(trackingCode: string) {
  return prisma.delivery.findUnique({
    where: {
      trackingCode,
    },
    select: {
      trackingCode: true,
      status: true,
      createdAt: true,
      assignedAt: true,
      pickedUpAt: true,
      deliveredAt: true,
      events: {
        select: {
          status: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });
}

export async function getDriverDeliveries(driverId: string) {
  return prisma.delivery.findMany({
    where: {
      driverId,
    },
    include: {
      customer: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
        },
      },
      events: {
        orderBy: {
          createdAt: "desc",
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}

export async function getDeliveryStatistics() {
  const [
    total,
    pending,
    assigned,
    pickedUp,
    inTransit,
    delivered,
    cancelled,
  ] = await Promise.all([
    prisma.delivery.count(),
    prisma.delivery.count({ where: { status: "PENDING" } }),
    prisma.delivery.count({ where: { status: "ASSIGNED" } }),
    prisma.delivery.count({ where: { status: "PICKED_UP" } }),
    prisma.delivery.count({ where: { status: "IN_TRANSIT" } }),
    prisma.delivery.count({ where: { status: "DELIVERED" } }),
    prisma.delivery.count({ where: { status: "CANCELLED" } }),
  ]);

  return {
    total,
    pending,
    assigned,
    pickedUp,
    inTransit,
    delivered,
    cancelled,
  };
}

export async function searchDeliveries(
  filters: {
    search?: string;
    status?: "PENDING" | "ASSIGNED" | "PICKED_UP" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";
    page: number;
    limit: number;
  },
) {
  const { search, status, page, limit } = filters;

  const where = {
    ...(status && { status }),

    ...(search && {
      OR: [
        {
          trackingCode: {
            contains: search,
            mode: "insensitive" as const,
          },
        },
        {
          recipientName: {
            contains: search,
            mode: "insensitive" as const,
          },
        },
        {
          recipientPhone: {
            contains: search,
          },
        },
        {
          pickupAddress: {
            contains: search,
            mode: "insensitive" as const,
          },
        },
        {
          deliveryAddress: {
            contains: search,
            mode: "insensitive" as const,
          },
        },
      ],
    }),
  };

  const [deliveries, total] = await Promise.all([
    prisma.delivery.findMany({
      where,
      include: {
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        driver: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      skip: (page - 1) * limit,
      take: limit,
    }),

    prisma.delivery.count({ where }),
  ]);

  return {
    deliveries,
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

export const updateDriverLocation = async (
  deliveryId: string,
  driverId: string,
  data: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  }
) => {
  const delivery = await prisma.delivery.findUnique({
    where: {
      id: deliveryId,
    },
    select: {
      id: true,
      driverId: true,
      status: true,
    },
  });

  if (!delivery) {
    throw new Error("DELIVERY_NOT_FOUND");
  }

  if (delivery.driverId !== driverId) {
    throw new Error("DRIVER_NOT_ASSIGNED");
  }

  if (!["PICKED_UP", "IN_TRANSIT"].includes(delivery.status)) {
    throw new Error("DELIVERY_NOT_ACTIVE");
  }

  const location = await prisma.driverLocation.create({
    data: {
      driverId,
      deliveryId,
      latitude: data.latitude,
      longitude: data.longitude,
      accuracy: data.accuracy,
    },
  });

  return location;
};

export const getDriverLocation = async (deliveryId: string) => {
  const delivery = await prisma.delivery.findUnique({
    where: {
      id: deliveryId,
    },
    select: {
      id: true,
    },
  });

  if (!delivery) {
    throw new Error("DELIVERY_NOT_FOUND");
  }

  const location = await prisma.driverLocation.findFirst({
    where: {
      deliveryId,
    },
    orderBy: {
      recordedAt: "desc",
    },
    select: {
      latitude: true,
      longitude: true,
      accuracy: true,
      recordedAt: true,
      driverId: true,
    },
  });

  return location;
};

export const getDriverLocationHistory = async (
  deliveryId: string,
  page = 1,
  limit = 50,
) => {
  const delivery = await prisma.delivery.findUnique({
    where: {
      id: deliveryId,
    },
    select: {
      id: true,
    },
  });

  if (!delivery) {
    throw new Error("DELIVERY_NOT_FOUND");
  }

  const skip = (page - 1) * limit;

  const [locations, total] = await Promise.all([
    prisma.driverLocation.findMany({
      where: {
        deliveryId,
      },
      orderBy: {
        recordedAt: "desc",
      },
      skip,
      take: limit,
      select: {
        id: true,
        latitude: true,
        longitude: true,
        accuracy: true,
        recordedAt: true,
        driverId: true,
      },
    }),

    prisma.driverLocation.count({
      where: {
        deliveryId,
      },
    }),
  ]);

  return {
    locations: locations.reverse(),

    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1,
    },
  };
};

