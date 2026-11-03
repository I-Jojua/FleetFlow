
import { randomBytes } from "node:crypto";
import { AuditOutcome, type Prisma, type UserRole } from "../../generated/prisma/client.js";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env.js";
import { writeAuditEvent } from "../audit/audit.service.js";
import { createNotificationsBestEffort } from "../notifications/notification.service";
import { sendSlackAlertBestEffort } from "../notifications/slack.service";
import { isStaffRole } from "../auth/authorization.js";
import { runIdempotently } from "../idempotency/idempotency.service.js";
import { publishDriverLocationUpdate } from "../realtime/realtime.gateway.js";
import { getRequestId } from "../../observability/request-context.js";
import { metrics } from "../../observability/metrics.js";
import { performance } from "node:perf_hooks";
import { revalidateDriverForAssignment } from "../dispatch/dispatch.service.js";
import type {
  CreateDeliveryInput,
  UpdateDriverLocationInput,
  UpdateDeliveryRequirementsInput,
} from "./delivery.validation";

function generateTrackingCode(): string {
  return `FF-${randomBytes(6).toString("hex").toUpperCase()}`;
}

export async function createDelivery(
  customerId: string,
  data: CreateDeliveryInput,
  actorId = customerId,
  actorRole?: UserRole,
  idempotencyKey?: string,
) {
  const execute = async (tx: Prisma.TransactionClient) => {
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
        requiredVehicleType: data.requiredVehicleType,
        minimumPayloadKg: data.minimumPayloadKg,
        minimumVolumeCubicMeters: data.minimumVolumeCubicMeters,
        requiresRefrigeratedTransport: data.requiresRefrigeratedTransport ?? false,
        requiredQualifications: [...new Set(data.requiredQualifications ?? [])],
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

    const roleSnapshot = actorRole ?? (actorId === customerId ? "CUSTOMER" : undefined);
    await writeAuditEvent(tx, {
      actor: roleSnapshot ? { userId: actorId, role: roleSnapshot } : null,
      action: "deliveries.create",
      resourceType: "delivery",
      resourceId: delivery.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { newStatus: delivery.status },
      captureIpAddress: roleSnapshot !== "CUSTOMER",
    });

    return delivery;
  };

  let delivery: Awaited<ReturnType<typeof execute>>;
  let replayed = false;
  if (idempotencyKey) {
    const result = await prisma.$transaction((tx) => runIdempotently(
      tx,
      {
        actorId,
        operation: "deliveries.create",
        key: idempotencyKey,
        request: { customerId, data },
        ttlHours: env.IDEMPOTENCY_KEY_TTL_HOURS,
      },
      async (transaction) => {
        const created = await execute(transaction);
        return { result: created, resourceType: "delivery", resourceId: created.id, statusCode: 201 };
      },
      (transaction, resourceType, resourceId) => resourceType === "delivery"
        ? transaction.delivery.findUnique({ where: { id: resourceId } })
        : Promise.resolve(null),
    ));
    delivery = result.result;
    replayed = result.replayed;
  } else {
    delivery = await prisma.$transaction(execute);
  }

  if (!replayed) {
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
  }

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

/** Resolve delivery details only within the authenticated caller's scope. */
export async function getDeliveryByIdForActor(
  id: string,
  actor: { id: string; role: UserRole },
) {
  const scope = isStaffRole(actor.role)
    ? {}
    : actor.role === "CUSTOMER"
      ? { customerId: actor.id }
      : actor.role === "DRIVER"
        ? { driverId: actor.id }
        : null;

  if (scope === null) return null;

  return prisma.delivery.findFirst({
    where: { id, ...scope },
    include: {
      customer: {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      },
      driver: {
        select: { id: true, firstName: true, lastName: true, phone: true },
      },
      events: { orderBy: { createdAt: "desc" } },
    },
  });
}

export async function updateDeliveryRequirements(
  deliveryId: string,
  data: UpdateDeliveryRequirementsInput,
  actorId: string,
  actorRole: UserRole,
) {
  if (!isStaffRole(actorRole)) throw new Error("DELIVERY_FORBIDDEN");
  return prisma.$transaction(async (tx) => {
    const delivery = await tx.delivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) throw new Error("DELIVERY_NOT_FOUND");
    if (delivery.status !== "PENDING") throw new Error("DELIVERY_REQUIREMENTS_NOT_EDITABLE");
    const updated = await tx.delivery.update({
      where: { id: deliveryId },
      data: {
        ...data,
        requiredQualifications: data.requiredQualifications
          ? [...new Set(data.requiredQualifications)]
          : undefined,
      },
    });
    await writeAuditEvent(tx, {
      actor: { userId: actorId, role: actorRole },
      action: "deliveries.requirements_update",
      resourceType: "delivery",
      resourceId: deliveryId,
      outcome: AuditOutcome.SUCCESS,
      metadata: { changedFields: Object.keys(data) },
      captureIpAddress: true,
    });
    return updated;
  }, { isolationLevel: "Serializable" });
}

export async function assignDriver(
  deliveryId: string,
  driverId: string,
  actorId: string,
  actorRole: UserRole,
  idempotencyKey?: string,
) {
  if (!isStaffRole(actorRole)) {
    throw new Error("DELIVERY_FORBIDDEN");
  }

  const execute = async (tx: Prisma.TransactionClient) => {
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

    const eligibility = await revalidateDriverForAssignment(tx, driverId, delivery);

    const assignment = await tx.delivery.updateMany({
      where: {
        id: deliveryId,
        status: delivery.status,
        driverId: delivery.driverId,
      },
      data: {
        driverId,
        vehicleId: eligibility.vehicleId,
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

    await writeAuditEvent(tx, {
      actor: { userId: actorId, role: actorRole },
      action: "deliveries.assign_driver",
      resourceType: "delivery",
      resourceId: deliveryId,
      outcome: AuditOutcome.SUCCESS,
      metadata: { changedFields: ["driverId", "status"] },
      captureIpAddress: true,
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
  };
  const transactionResult = idempotencyKey
    ? await prisma.$transaction((tx) => runIdempotently(
        tx,
        {
          actorId,
          operation: "deliveries.assign_driver",
          key: idempotencyKey,
          request: { deliveryId, driverId },
          ttlHours: env.IDEMPOTENCY_KEY_TTL_HOURS,
        },
        async (transaction) => {
          const result = await execute(transaction);
          return {
            result,
            resourceType: "delivery",
            resourceId: deliveryId,
            statusCode: 200,
          };
        },
        async (transaction, resourceType, resourceId) => resourceType === "delivery"
          ? await transaction.delivery.findUnique({ where: { id: resourceId } }).then((delivery) => delivery
              ? { delivery, customerId: delivery.customerId, driverId: delivery.driverId ?? "", previousDriverId: null, trackingCode: delivery.trackingCode, changed: false }
              : null)
          : null,
      ), { isolationLevel: "Serializable" })
    : {
        result: await prisma.$transaction(execute, { isolationLevel: "Serializable" }),
        replayed: false,
      };
  const result = transactionResult.result;

  if (transactionResult.replayed || !result.changed) return result.delivery;

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

    const isStaff = isStaffRole(actor.role);
    if (actor.role === "CUSTOMER" && delivery.customerId !== actor.id) {
      throw new Error("DELIVERY_NOT_FOUND");
    }
    if (actor.role === "DRIVER" && delivery.driverId !== actor.id) {
      throw new Error("DELIVERY_NOT_FOUND");
    }
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

    await writeAuditEvent(tx, {
      actor: { userId: actor.id, role: actor.role },
      action: newStatus === "CANCELLED" ? "deliveries.cancel" : "deliveries.status_update",
      resourceType: "delivery",
      resourceId: deliveryId,
      outcome: AuditOutcome.SUCCESS,
      metadata: { fromStatus: delivery.status, toStatus: newStatus },
      captureIpAddress: actor.role !== "CUSTOMER",
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
  data: UpdateDriverLocationInput
) => {
  const startedAt = performance.now();
  if (!Number.isFinite(data.latitude) || data.latitude < -90 || data.latitude > 90 ||
      !Number.isFinite(data.longitude) || data.longitude < -180 || data.longitude > 180 ||
      (data.accuracy !== undefined && (!Number.isFinite(data.accuracy) || data.accuracy <= 0 || data.accuracy > 100_000))) {
    throw new Error("LOCATION_INVALID");
  }

  const requestedRecordedAt = data.timestamp ? new Date(data.timestamp) : new Date();
  if (!Number.isFinite(requestedRecordedAt.getTime())) throw new Error("LOCATION_INVALID_TIMESTAMP");
  const now = Date.now();
  const oldestAllowed = now - env.GPS_MAX_AGE_SECONDS * 1_000;
  const newestAllowed = now + env.GPS_MAX_FUTURE_SKEW_SECONDS * 1_000;
  if (requestedRecordedAt.getTime() < oldestAllowed) throw new Error("LOCATION_STALE");
  if (requestedRecordedAt.getTime() > newestAllowed) throw new Error("LOCATION_TIMESTAMP_IN_FUTURE");

  const location = await prisma.$transaction(async (tx) => {
    // Serialize by driver so samples across multiple assignments cannot move
    // a driver's location clock backwards under concurrent requests.
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`gps:${driverId}`}, 0))) AS gps_lock`;
    await tx.$queryRaw`SELECT 1 FROM deliveries WHERE id = ${deliveryId}::uuid FOR UPDATE`;

    const delivery = await tx.delivery.findUnique({
      where: { id: deliveryId },
      select: { id: true, driverId: true, status: true },
    });
    if (!delivery || delivery.driverId !== driverId) throw new Error("DELIVERY_NOT_FOUND");
    if (!["PICKED_UP", "IN_TRANSIT"].includes(delivery.status)) throw new Error("DELIVERY_NOT_ACTIVE");

    const latest = await tx.driverLocation.findFirst({
      where: { driverId },
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      select: { recordedAt: true },
    });
    let recordedAt = requestedRecordedAt;
    if (latest && recordedAt.getTime() <= latest.recordedAt.getTime()) {
      if (data.timestamp) throw new Error("LOCATION_OUT_OF_ORDER");
      recordedAt = new Date(latest.recordedAt.getTime() + 1);
    }

    return tx.driverLocation.create({
      data: {
        driverId,
        deliveryId,
        latitude: data.latitude,
        longitude: data.longitude,
        accuracy: data.accuracy,
        recordedAt,
      },
    });
  });
  metrics.recordGpsIngestion(performance.now() - startedAt);
  await publishDriverLocationUpdate({ ...location, requestId: getRequestId() });
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
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
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
  range: { from?: Date; to?: Date } = {},
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
        ...(range.from || range.to ? {
          recordedAt: {
            ...(range.from ? { gte: range.from } : {}),
            ...(range.to ? { lte: range.to } : {}),
          },
        } : {}),
      },
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
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
        ...(range.from || range.to ? {
          recordedAt: {
            ...(range.from ? { gte: range.from } : {}),
            ...(range.to ? { lte: range.to } : {}),
          },
        } : {}),
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

