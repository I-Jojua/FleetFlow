import { AuditOutcome, type Prisma, type UserRole } from "../../generated/prisma/client.js";
import { prisma } from "../../config/prisma.js";
import { writeAuditEvent } from "../audit/audit.service.js";
import type { CreateVehicleInput, UpdateVehicleInput, VehicleListQuery } from "./vehicle.validation.js";

type Actor = { userId: string; role: UserRole };
const ACTIVE_DELIVERY_STATUSES = ["ASSIGNED", "PICKED_UP", "IN_TRANSIT"] as const;

async function lockKeys(tx: Prisma.TransactionClient, keys: string[]) {
  for (const key of [...new Set(keys)].sort()) {
    await tx.$queryRaw<Array<{ locked: number }>>`
      WITH lock_result AS (
        SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
      ) SELECT 1::integer AS locked FROM lock_result
    `;
  }
}

async function assertVehicleHasNoActiveWork(tx: Prisma.TransactionClient, vehicleId: string) {
  const [directDeliveries, assignments] = await Promise.all([
    tx.delivery.count({ where: { vehicleId, status: { in: [...ACTIVE_DELIVERY_STATUSES] } } }),
    tx.driverVehicleAssignment.findMany({ where: { vehicleId, endedAt: null }, select: { driverId: true } }),
  ]);
  if (directDeliveries > 0) throw new Error("VEHICLE_HAS_ACTIVE_DELIVERIES");
  if (assignments.length) {
    const driverIds = assignments.map((assignment) => assignment.driverId);
    const activeWork = await tx.delivery.count({ where: { driverId: { in: driverIds }, status: { in: [...ACTIVE_DELIVERY_STATUSES] } } });
    if (activeWork > 0) throw new Error("VEHICLE_HAS_ACTIVE_DELIVERIES");
  }
}

export async function createVehicle(data: CreateVehicleInput, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const vehicle = await tx.vehicle.create({ data: {
      ...data,
      maximumPayloadKg: data.maximumPayloadKg,
      maximumVolumeCubicMeters: data.maximumVolumeCubicMeters ?? null,
      description: data.description ?? null,
    } });
    await writeAuditEvent(tx, { actor, action: "vehicles.create", resourceType: "vehicle", resourceId: vehicle.id, outcome: AuditOutcome.SUCCESS, captureIpAddress: true });
    return vehicle;
  });
}

export async function listVehicles(filters: VehicleListQuery) {
  const where: Prisma.VehicleWhereInput = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.search ? { registrationIdentifier: { contains: filters.search.toUpperCase(), mode: "insensitive" } } : {}),
  };
  const [vehicles, total] = await prisma.$transaction([
    prisma.vehicle.findMany({
      where,
      orderBy: [{ registrationIdentifier: "asc" }, { id: "asc" }],
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      include: { assignments: { where: { endedAt: null }, take: 1, select: { id: true, driverId: true, startedAt: true } } },
    }),
    prisma.vehicle.count({ where }),
  ]);
  return { vehicles, pagination: { total, page: filters.page, limit: filters.limit, totalPages: Math.ceil(total / filters.limit), hasNextPage: filters.page * filters.limit < total, hasPreviousPage: filters.page > 1 } };
}

export async function getVehicle(vehicleId: string) {
  return prisma.vehicle.findUnique({
    where: { id: vehicleId },
    include: { assignments: { where: { endedAt: null }, take: 1, select: { id: true, driverId: true, startedAt: true } } },
  });
}

export async function listVehicleAssignments(vehicleId: string, page: number, limit: number) {
  const exists = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true } });
  if (!exists) throw new Error("VEHICLE_NOT_FOUND");
  const where = { vehicleId };
  const [assignments, total] = await prisma.$transaction([
    prisma.driverVehicleAssignment.findMany({
      where, orderBy: [{ startedAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit,
      select: { id: true, driverId: true, vehicleId: true, startedAt: true, endedAt: true },
    }),
    prisma.driverVehicleAssignment.count({ where }),
  ]);
  return { assignments, pagination: { total, page, limit, totalPages: Math.ceil(total / limit), hasNextPage: page * limit < total, hasPreviousPage: page > 1 } };
}

export async function updateVehicle(vehicleId: string, data: UpdateVehicleInput, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await lockKeys(tx, [`vehicle:${vehicleId}`]);
    const current = await tx.vehicle.findUnique({ where: { id: vehicleId } });
    if (!current) throw new Error("VEHICLE_NOT_FOUND");
    const payloadDecreased = data.maximumPayloadKg !== undefined && data.maximumPayloadKg < Number(current.maximumPayloadKg);
    const volumeDecreased = data.maximumVolumeCubicMeters !== undefined && (
      data.maximumVolumeCubicMeters === null
        ? current.maximumVolumeCubicMeters !== null
        : current.maximumVolumeCubicMeters !== null && data.maximumVolumeCubicMeters < Number(current.maximumVolumeCubicMeters)
    );
    const typeChanged = data.type !== undefined && data.type !== current.type;
    const refrigerationRemoved = data.refrigerated === false && current.refrigerated;
    if (payloadDecreased || volumeDecreased || typeChanged || refrigerationRemoved) {
      await assertVehicleHasNoActiveWork(tx, vehicleId);
    }
    const updated = await tx.vehicle.update({ where: { id: vehicleId }, data });
    await writeAuditEvent(tx, { actor, action: "vehicles.update", resourceType: "vehicle", resourceId: vehicleId, outcome: AuditOutcome.SUCCESS, metadata: { changedFields: Object.keys(data) }, captureIpAddress: true });
    return updated;
  }, { isolationLevel: "Serializable" });
}

export async function updateVehicleStatus(vehicleId: string, status: "ACTIVE" | "MAINTENANCE" | "INACTIVE", actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await lockKeys(tx, [`vehicle:${vehicleId}`]);
    const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) throw new Error("VEHICLE_NOT_FOUND");
    if (status !== "ACTIVE") await assertVehicleHasNoActiveWork(tx, vehicleId);
    const updated = await tx.vehicle.update({ where: { id: vehicleId }, data: { status } });
    await writeAuditEvent(tx, { actor, action: "vehicles.status_update", resourceType: "vehicle", resourceId: vehicleId, outcome: AuditOutcome.SUCCESS, metadata: { previousStatus: vehicle.status, newStatus: updated.status }, captureIpAddress: true });
    return updated;
  }, { isolationLevel: "Serializable" });
}

export async function assignVehicleToDriver(vehicleId: string, driverId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const initialAssignment = await tx.driverVehicleAssignment.findFirst({ where: { driverId, endedAt: null } });
    await lockKeys(tx, [
      `dispatch-driver:${driverId}`,
      `vehicle:${vehicleId}`,
      ...(initialAssignment ? [`vehicle:${initialAssignment.vehicleId}`] : []),
    ]);
    const [driver, vehicle] = await Promise.all([
      tx.user.findFirst({ where: { id: driverId, role: "DRIVER", status: "ACTIVE" }, select: { id: true } }),
      tx.vehicle.findUnique({ where: { id: vehicleId } }),
    ]);
    if (!driver) throw new Error("DRIVER_NOT_FOUND_OR_INACTIVE");
    if (!vehicle) throw new Error("VEHICLE_NOT_FOUND");
    if (vehicle.status !== "ACTIVE") throw new Error("VEHICLE_NOT_ACTIVE");

    const currentDriverAssignment = await tx.driverVehicleAssignment.findFirst({ where: { driverId, endedAt: null } });
    if (currentDriverAssignment?.vehicleId === vehicleId) return currentDriverAssignment;
    if (currentDriverAssignment && currentDriverAssignment.vehicleId !== initialAssignment?.vehicleId) {
      // A concurrent change is serialized by the driver lock; Serializable aborts this transaction if the snapshot is stale.
      throw new Error("VEHICLE_ASSIGNMENT_CHANGED");
    }
    const currentVehicleAssignment = await tx.driverVehicleAssignment.findFirst({ where: { vehicleId, endedAt: null } });
    if (currentVehicleAssignment && currentVehicleAssignment.driverId !== driverId) throw new Error("VEHICLE_ALREADY_ASSIGNED");
    const activeWork = await tx.delivery.count({ where: { driverId, status: { in: [...ACTIVE_DELIVERY_STATUSES] } } });
    if (activeWork > 0) throw new Error("DRIVER_HAS_ACTIVE_DELIVERIES");

    if (currentDriverAssignment) {
      await tx.driverVehicleAssignment.update({ where: { id: currentDriverAssignment.id }, data: { endedAt: new Date() } });
    }
    const assignment = await tx.driverVehicleAssignment.create({ data: { driverId, vehicleId } });
    await writeAuditEvent(tx, { actor, action: "vehicles.assign_driver", resourceType: "vehicle", resourceId: vehicleId, outcome: AuditOutcome.SUCCESS, metadata: { changedFields: ["driverId"] }, captureIpAddress: true });
    return assignment;
  }, { isolationLevel: "Serializable" });
}

export async function unassignVehicleFromDriver(vehicleId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const initiallyCurrent = await tx.driverVehicleAssignment.findFirst({ where: { vehicleId, endedAt: null } });
    if (!initiallyCurrent) throw new Error("VEHICLE_ASSIGNMENT_NOT_FOUND");
    await lockKeys(tx, [`dispatch-driver:${initiallyCurrent.driverId}`, `vehicle:${vehicleId}`]);
    const current = await tx.driverVehicleAssignment.findFirst({ where: { vehicleId, endedAt: null } });
    if (!current) throw new Error("VEHICLE_ASSIGNMENT_NOT_FOUND");
    const activeWork = await tx.delivery.count({ where: { driverId: current.driverId, status: { in: [...ACTIVE_DELIVERY_STATUSES] } } });
    if (activeWork > 0) throw new Error("DRIVER_HAS_ACTIVE_DELIVERIES");
    const assignment = await tx.driverVehicleAssignment.update({ where: { id: current.id }, data: { endedAt: new Date() } });
    await writeAuditEvent(tx, { actor, action: "vehicles.unassign_driver", resourceType: "vehicle", resourceId: vehicleId, outcome: AuditOutcome.SUCCESS, metadata: { changedFields: ["driverId"] }, captureIpAddress: true });
    return assignment;
  }, { isolationLevel: "Serializable" });
}
