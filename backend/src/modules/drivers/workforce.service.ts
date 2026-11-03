import { AuditOutcome, type Prisma, type UserRole } from "../../generated/prisma/client.js";
import { prisma } from "../../config/prisma.js";
import { writeAuditEvent } from "../audit/audit.service.js";
import type { CreateQualificationInput, CreateShiftInput } from "./workforce.validation.js";

type Actor = { userId: string; role: UserRole };
type WorkforceTx = Prisma.TransactionClient;

async function lockDriver(tx: WorkforceTx, driverId: string) {
  await tx.$queryRaw<Array<{ locked: number }>>`
    WITH lock_result AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${`dispatch-driver:${driverId}`}, 0))
    ) SELECT 1::integer AS locked FROM lock_result
  `;
}

async function requireDriver(tx: WorkforceTx, driverId: string, active = false) {
  const driver = await tx.user.findFirst({
    where: { id: driverId, role: "DRIVER", ...(active ? { status: "ACTIVE" } : {}) },
    select: { id: true, status: true, availability: true },
  });
  if (!driver) throw new Error("DRIVER_NOT_FOUND");
  return driver;
}

export async function updateDriverAvailability(driverId: string, availability: "AVAILABLE" | "UNAVAILABLE" | "ON_BREAK" | "OFF_DUTY" | "SUSPENDED", actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await lockDriver(tx, driverId);
    const driver = await requireDriver(tx, driverId);
    if (availability === "AVAILABLE" && driver.status !== "ACTIVE") throw new Error("INACTIVE_DRIVER_CANNOT_BE_AVAILABLE");
    const transitions: Record<typeof driver.availability, readonly string[]> = {
      AVAILABLE: ["UNAVAILABLE", "ON_BREAK", "OFF_DUTY", "SUSPENDED"],
      UNAVAILABLE: ["AVAILABLE", "ON_BREAK", "OFF_DUTY", "SUSPENDED"],
      ON_BREAK: ["AVAILABLE", "UNAVAILABLE", "OFF_DUTY", "SUSPENDED"],
      OFF_DUTY: ["AVAILABLE", "UNAVAILABLE", "SUSPENDED"],
      SUSPENDED: ["UNAVAILABLE", "OFF_DUTY"],
    };
    if (driver.availability !== availability && !transitions[driver.availability].includes(availability)) {
      throw new Error("INVALID_AVAILABILITY_TRANSITION");
    }
    if (availability === "SUSPENDED") {
      const activeDeliveries = await tx.delivery.count({ where: { driverId, status: { in: ["ASSIGNED", "PICKED_UP", "IN_TRANSIT"] } } });
      if (activeDeliveries > 0) throw new Error("DRIVER_HAS_ACTIVE_DELIVERIES");
    }
    const updated = await tx.user.update({ where: { id: driverId }, data: { availability }, select: { id: true, status: true, availability: true, updatedAt: true } });
    await writeAuditEvent(tx, {
      actor,
      action: "drivers.availability_update",
      resourceType: "driver",
      resourceId: driverId,
      outcome: AuditOutcome.SUCCESS,
      metadata: { previousAvailability: driver.availability, newAvailability: updated.availability },
      captureIpAddress: true,
    });
    return updated;
  }, { isolationLevel: "Serializable" });
}

export async function listQualifications(driverId: string, filters: { verificationStatus?: "PENDING" | "VERIFIED" | "REJECTED"; page: number; limit: number }) {
  const where = { driverId, ...(filters.verificationStatus ? { verificationStatus: filters.verificationStatus } : {}) };
  const [qualifications, total] = await prisma.$transaction([
    prisma.driverQualification.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (filters.page - 1) * filters.limit, take: filters.limit }),
    prisma.driverQualification.count({ where }),
  ]);
  return { qualifications, pagination: { total, page: filters.page, limit: filters.limit, totalPages: Math.ceil(total / filters.limit), hasNextPage: filters.page * filters.limit < total, hasPreviousPage: filters.page > 1 } };
}

export async function createQualification(driverId: string, data: CreateQualificationInput, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await requireDriver(tx, driverId);
    const duplicate = await tx.driverQualification.findFirst({
      where: {
        driverId,
        qualificationType: data.qualificationType,
        licenseCategory: data.licenseCategory ?? null,
        verificationStatus: { in: ["PENDING", "VERIFIED"] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true },
    });
    if (duplicate) throw new Error("QUALIFICATION_ALREADY_EXISTS");
    const qualification = await tx.driverQualification.create({
      data: {
        driverId,
        qualificationType: data.qualificationType,
        licenseCategory: data.licenseCategory,
        issuedAt: data.issuedAt,
        expiresAt: data.expiresAt,
        notes: data.notes,
      },
    });
    await writeAuditEvent(tx, {
      actor,
      action: "drivers.qualification_create",
      resourceType: "driver_qualification",
      resourceId: qualification.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { status: qualification.verificationStatus },
      captureIpAddress: true,
    });
    return qualification;
  });
}

export async function verifyQualification(driverId: string, qualificationId: string, status: "VERIFIED" | "REJECTED", actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const qualification = await tx.driverQualification.findFirst({ where: { id: qualificationId, driverId } });
    if (!qualification) throw new Error("QUALIFICATION_NOT_FOUND");
    const allowed: Record<typeof qualification.verificationStatus, readonly string[]> = {
      PENDING: ["VERIFIED", "REJECTED"],
      VERIFIED: ["REJECTED"],
      REJECTED: ["VERIFIED"],
    };
    if (qualification.verificationStatus !== status && !allowed[qualification.verificationStatus].includes(status)) {
      throw new Error("INVALID_QUALIFICATION_TRANSITION");
    }
    const updated = await tx.driverQualification.update({
      where: { id: qualification.id },
      data: { verificationStatus: status, verifiedAt: new Date(), verifiedById: actor.userId },
    });
    await writeAuditEvent(tx, {
      actor,
      action: "drivers.qualification_verify",
      resourceType: "driver_qualification",
      resourceId: qualification.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { previousStatus: qualification.verificationStatus, newStatus: updated.verificationStatus },
      captureIpAddress: true,
    });
    return updated;
  });
}

async function assertNoShiftOverlap(tx: WorkforceTx, driverId: string, startsAt: Date, endsAt: Date, excludeId?: string) {
  const conflict = await tx.driverShift.findFirst({
    where: {
      driverId,
      status: { in: ["SCHEDULED", "ACTIVE"] },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (conflict) throw new Error("DRIVER_SHIFT_OVERLAP");
}

export async function listDriverShifts(driverId: string, filters: { status?: "SCHEDULED" | "ACTIVE" | "COMPLETED" | "CANCELLED"; from?: Date; to?: Date; page: number; limit: number }) {
  const where: Prisma.DriverShiftWhereInput = {
    driverId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.from || filters.to ? { startsAt: { ...(filters.to ? { lte: filters.to } : {}) }, endsAt: { ...(filters.from ? { gte: filters.from } : {}) } } : {}),
  };
  const [shifts, total] = await prisma.$transaction([
    prisma.driverShift.findMany({ where, orderBy: [{ startsAt: "desc" }, { id: "desc" }], skip: (filters.page - 1) * filters.limit, take: filters.limit }),
    prisma.driverShift.count({ where }),
  ]);
  return { shifts, pagination: { total, page: filters.page, limit: filters.limit, totalPages: Math.ceil(total / filters.limit), hasNextPage: filters.page * filters.limit < total, hasPreviousPage: filters.page > 1 } };
}

export async function createDriverShift(driverId: string, data: CreateShiftInput, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await lockDriver(tx, driverId);
    await requireDriver(tx, driverId, true);
    await assertNoShiftOverlap(tx, driverId, data.startsAt, data.endsAt);
    const shift = await tx.driverShift.create({ data: { driverId, ...data } });
    await writeAuditEvent(tx, { actor, action: "drivers.shift_create", resourceType: "driver_shift", resourceId: shift.id, outcome: AuditOutcome.SUCCESS, captureIpAddress: true });
    return shift;
  }, { isolationLevel: "Serializable" });
}

export async function updateDriverShift(driverId: string, shiftId: string, data: CreateShiftInput, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await lockDriver(tx, driverId);
    const shift = await tx.driverShift.findFirst({ where: { id: shiftId, driverId } });
    if (!shift) throw new Error("DRIVER_SHIFT_NOT_FOUND");
    if (shift.status !== "SCHEDULED") throw new Error("DRIVER_SHIFT_NOT_EDITABLE");
    await assertNoShiftOverlap(tx, driverId, data.startsAt, data.endsAt, shiftId);
    const updated = await tx.driverShift.update({ where: { id: shiftId }, data });
    await writeAuditEvent(tx, { actor, action: "drivers.shift_update", resourceType: "driver_shift", resourceId: shiftId, outcome: AuditOutcome.SUCCESS, captureIpAddress: true });
    return updated;
  }, { isolationLevel: "Serializable" });
}

export async function updateDriverShiftStatus(driverId: string, shiftId: string, status: "ACTIVE" | "COMPLETED" | "CANCELLED", actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await lockDriver(tx, driverId);
    const shift = await tx.driverShift.findFirst({ where: { id: shiftId, driverId } });
    if (!shift) throw new Error("DRIVER_SHIFT_NOT_FOUND");
    const transitions: Record<typeof shift.status, readonly string[]> = {
      SCHEDULED: ["ACTIVE", "CANCELLED"],
      ACTIVE: ["COMPLETED", "CANCELLED"],
      COMPLETED: [],
      CANCELLED: [],
    };
    if (!transitions[shift.status].includes(status)) throw new Error("INVALID_SHIFT_TRANSITION");
    const now = new Date();
    if (status === "ACTIVE" && (now < shift.startsAt || now >= shift.endsAt)) throw new Error("SHIFT_NOT_CURRENT");
    if (status === "COMPLETED" && now < shift.endsAt) throw new Error("SHIFT_NOT_FINISHED");
    if (status === "CANCELLED" && shift.status === "ACTIVE") {
      const activeDeliveries = await tx.delivery.count({ where: { driverId, status: { in: ["ASSIGNED", "PICKED_UP", "IN_TRANSIT"] } } });
      if (activeDeliveries) throw new Error("DRIVER_HAS_ACTIVE_DELIVERIES");
    }
    const updated = await tx.driverShift.update({ where: { id: shiftId }, data: { status } });
    await writeAuditEvent(tx, { actor, action: "drivers.shift_status", resourceType: "driver_shift", resourceId: shiftId, outcome: AuditOutcome.SUCCESS, metadata: { previousStatus: shift.status, newStatus: updated.status }, captureIpAddress: true });
    return updated;
  }, { isolationLevel: "Serializable" });
}
