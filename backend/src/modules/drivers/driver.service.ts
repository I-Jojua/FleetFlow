import argon2 from "argon2";
import { prisma } from "../../config/prisma";
import type {
  CreateDriverInput,
  UpdateDriverInput,
  DriverQueryInput,
} from "./driver.validation";

export async function createDriver(data: CreateDriverInput) {
  const passwordHash = await argon2.hash(data.password, {
    type: argon2.argon2id,
  });

  return prisma.user.create({
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      phone: data.phone ?? null,
      passwordHash,
      role: "DRIVER",
      status: "ACTIVE",
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      role: true,
      status: true,
      createdAt: true,
    },
  });
}

export async function getAllDrivers(filters: DriverQueryInput) {
  const { search, status, page, limit } = filters;

  const where = {
    role: "DRIVER" as const,
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
            { phone: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const skip = (page - 1) * limit;

  const [drivers, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
        createdAt: true,
        _count: {
          select: {
            assignedDeliveries: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    drivers,
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

export async function getDriverById(id: string) {
  return prisma.user.findFirst({
    where: {
      id,
      role: "DRIVER",
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      assignedDeliveries: {
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          trackingCode: true,
          status: true,
          recipientName: true,
          deliveryAddress: true,
          createdAt: true,
        },
      },
      _count: {
        select: {
          assignedDeliveries: true,
          driverLocations: true,
        },
      },
    },
  });
}

export async function updateDriver(id: string, data: UpdateDriverInput) {
  const driver = await prisma.user.findFirst({
    where: { id, role: "DRIVER" },
    select: { id: true },
  });

  if (!driver) {
    throw new Error("DRIVER_NOT_FOUND");
  }

  return prisma.user.update({
    where: { id },
    data,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      status: true,
      updatedAt: true,
    },
  });
}

export async function updateDriverStatus(
  id: string,
  status: "ACTIVE" | "INACTIVE" | "SUSPENDED" | "PENDING_VERIFICATION",
) {
  return prisma.$transaction(async (tx) => {
    const driver = await tx.user.findFirst({
      where: { id, role: "DRIVER" },
      select: { id: true },
    });

    if (!driver) {
      throw new Error("DRIVER_NOT_FOUND");
    }

    if (status !== "ACTIVE") {
      const activeDeliveries = await tx.delivery.count({
        where: {
          driverId: id,
          status: { in: ["ASSIGNED", "PICKED_UP", "IN_TRANSIT"] },
        },
      });

      if (activeDeliveries > 0) {
        throw new Error("DRIVER_HAS_ACTIVE_DELIVERIES");
      }
    }

    return tx.user.update({
      where: { id },
      data: { status },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
      },
    });
  }, { isolationLevel: "Serializable" });
}

export async function getDriverStatistics(id: string) {
  const driver = await prisma.user.findFirst({
    where: { id, role: "DRIVER" },
    select: {
      id: true,
      firstName: true,
      lastName: true,
    },
  });

  if (!driver) {
    throw new Error("DRIVER_NOT_FOUND");
  }

  const [
    total,
    pending,
    assigned,
    pickedUp,
    inTransit,
    delivered,
    cancelled,
  ] = await Promise.all([
    prisma.delivery.count({ where: { driverId: id } }),
    prisma.delivery.count({ where: { driverId: id, status: "PENDING" } }),
    prisma.delivery.count({ where: { driverId: id, status: "ASSIGNED" } }),
    prisma.delivery.count({ where: { driverId: id, status: "PICKED_UP" } }),
    prisma.delivery.count({ where: { driverId: id, status: "IN_TRANSIT" } }),
    prisma.delivery.count({ where: { driverId: id, status: "DELIVERED" } }),
    prisma.delivery.count({ where: { driverId: id, status: "CANCELLED" } }),
  ]);

  return {
    driver,
    deliveries: {
      total,
      pending,
      assigned,
      pickedUp,
      inTransit,
      delivered,
      cancelled,
    },
  };
}
