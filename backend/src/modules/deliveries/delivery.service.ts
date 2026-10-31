
import { randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../config/prisma";
import type {
  CreateDeliveryInput,
} from "./delivery.validation";

function generateTrackingCode(): string {
  return `FF-${randomBytes(6).toString("hex").toUpperCase()}`;
}

export async function createDelivery(
  customerId: string,
  data: CreateDeliveryInput,
) {
  return prisma.$transaction(async (tx) => {
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
        actorId: customerId,
        status: "PENDING",
        description: "Delivery order created",
      },
    });

    return delivery;
  });
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
) {
  return prisma.$transaction(async (tx) => {
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

    const updated = await tx.delivery.update({
      where: { id: deliveryId },
      data: {
        driverId,
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });

    await tx.deliveryEvent.create({
      data: {
        deliveryId,
        actorId,
        status: "ASSIGNED",
        description: `Driver assigned: ${driver.firstName} ${driver.lastName}`,
      },
    });

    return updated;
  });
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
  actorId: string,
  newStatus: "PICKED_UP" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED",
) {
  return prisma.$transaction(async (tx) => {
    const delivery = await tx.delivery.findUnique({
      where: { id: deliveryId },
    });

    if (!delivery) {
      throw new Error("DELIVERY_NOT_FOUND");
    }

    const allowedTransitions: Record<string, string[]> = {
      ASSIGNED: ["PICKED_UP", "CANCELLED"],
      PICKED_UP: ["IN_TRANSIT"],
      IN_TRANSIT: ["DELIVERED"],
    };

    if (!allowedTransitions[delivery.status]?.includes(newStatus)) {
      throw new Error("INVALID_STATUS_TRANSITION");
    }

    const updated = await tx.delivery.update({
      where: { id: deliveryId },
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

    await tx.deliveryEvent.create({
      data: {
        deliveryId,
        actorId,
        status: newStatus,
        description: `Delivery status changed to ${newStatus}`,
      },
    });

    return updated;
  });
}

export async function trackDelivery(trackingCode: string) {
  return prisma.delivery.findUnique({
    where: {
      trackingCode,
    },
    select: {
      trackingCode: true,
      status: true,
      recipientName: true,
      pickupAddress: true,
      deliveryAddress: true,
      createdAt: true,
      assignedAt: true,
      pickedUpAt: true,
      deliveredAt: true,
      events: {
        select: {
          status: true,
          description: true,
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

