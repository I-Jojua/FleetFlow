import argon2 from "argon2";
import { prisma } from "../../config/prisma";
import type {
  CreateDriverInput,
  UpdateDriverInput,
  DriverQueryInput,
} from "./driver.validation";
import { AuditOutcome, type UserRole } from "../../generated/prisma/client.js";
import { writeAuditEvent } from "../audit/audit.service.js";

export async function createDriver(data: CreateDriverInput, actor?: { userId: string; role: UserRole }) {
  const passwordHash = await argon2.hash(data.password, {
    type: argon2.argon2id,
  });

  return prisma.$transaction(async (tx) => {
    const driver = await tx.user.create({
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
    await writeAuditEvent(tx, {
      actor,
      action: "drivers.create",
      resourceType: "driver",
      resourceId: driver.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { newRole: "DRIVER", newStatus: "ACTIVE" },
      captureIpAddress: true,
    });
    return driver;
  });
}

export async function getAllDrivers(filters: DriverQueryInput) {
  const { search, status, page, limit } = filters;

  const where = {
    role: "DRIVER" as const,
    ...(status ? { status } : {}),
    ...(filters.availability ? { availability: filters.availability } : {}),
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
        availability: true,
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
      availability: true,
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

export async function updateDriver(id: string, data: UpdateDriverInput, actor?: { userId: string; role: UserRole }) {
  return prisma.$transaction(async (tx) => {
    const driver = await tx.user.findFirst({
      where: { id, role: "DRIVER" },
      select: { id: true },
    });
    if (!driver) throw new Error("DRIVER_NOT_FOUND");

    const updated = await tx.user.update({
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
    await writeAuditEvent(tx, {
      actor,
      action: "drivers.update",
      resourceType: "driver",
      resourceId: id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { changedFields: Object.keys(data) },
      captureIpAddress: true,
    });
    return updated;
  });
}

export async function updateDriverStatus(
  id: string,
  status: "ACTIVE" | "INACTIVE" | "SUSPENDED" | "PENDING_VERIFICATION",
  actor?: { userId: string; role: UserRole },
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ locked: number }>>`
      WITH lock_result AS (
        SELECT pg_advisory_xact_lock(hashtextextended(${`dispatch-driver:${id}`}, 0))
      ) SELECT 1::integer AS locked FROM lock_result
    `;
    const driver = await tx.user.findFirst({
      where: { id, role: "DRIVER" },
      select: { id: true, status: true, availability: true },
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

    const updated = await tx.user.update({
      where: { id },
      data: {
        status,
        availability: status === "ACTIVE"
          ? (driver.availability === "SUSPENDED" ? "OFF_DUTY" : driver.availability)
          : "SUSPENDED",
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        availability: true,
      },
    });
    await writeAuditEvent(tx, {
      actor,
      action: "drivers.status_update",
      resourceType: "driver",
      resourceId: id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { previousStatus: driver.status, newStatus: updated.status },
      captureIpAddress: true,
    });
    if (driver.availability !== updated.availability) {
      await writeAuditEvent(tx, {
        actor,
        action: "drivers.availability_update",
        resourceType: "driver",
        resourceId: id,
        outcome: AuditOutcome.SUCCESS,
        metadata: { previousAvailability: driver.availability, newAvailability: updated.availability },
        captureIpAddress: true,
      });
    }
    return updated;
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

export async function getActiveDriverLocations(page: number, limit: number) {
  const skip = (page - 1) * limit;
  const rows = await prisma.$queryRaw<Array<{
    driverId: string;
    deliveryId: string;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    recordedAt: Date;
    total: number;
  }>>`
    WITH latest_active_locations AS (
      SELECT DISTINCT ON (location.driver_id)
        location.driver_id AS "driverId",
        location.delivery_id AS "deliveryId",
        location.latitude,
        location.longitude,
        location.accuracy,
        location.recorded_at AS "recordedAt"
      FROM driver_locations AS location
      INNER JOIN deliveries AS delivery ON delivery.id = location.delivery_id
      INNER JOIN users AS driver ON driver.id = location.driver_id
      WHERE delivery.status IN ('ASSIGNED', 'PICKED_UP', 'IN_TRANSIT')
        AND driver.role = 'DRIVER'
        AND driver.status = 'ACTIVE'
      ORDER BY location.driver_id, location.recorded_at DESC, location.id DESC
    ),
    selected_page AS (
      SELECT * FROM latest_active_locations
      ORDER BY "recordedAt" DESC, "driverId" ASC
      LIMIT ${limit} OFFSET ${skip}
    )
    SELECT selected_page.*, (SELECT COUNT(*)::int FROM latest_active_locations) AS total
    FROM selected_page
    ORDER BY "recordedAt" DESC, "driverId" ASC
  `;

  const total = rows[0]?.total ?? await prisma.$queryRaw<Array<{ total: number }>>`
    SELECT COUNT(DISTINCT location.driver_id)::int AS total
    FROM driver_locations AS location
    INNER JOIN deliveries AS delivery ON delivery.id = location.delivery_id
    INNER JOIN users AS driver ON driver.id = location.driver_id
    WHERE delivery.status IN ('ASSIGNED', 'PICKED_UP', 'IN_TRANSIT')
      AND driver.role = 'DRIVER'
      AND driver.status = 'ACTIVE'
  `.then((result) => result[0]?.total ?? 0);

  return {
    locations: rows.map(({ total: _total, ...location }) => location),
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
