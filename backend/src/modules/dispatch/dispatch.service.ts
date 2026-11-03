import { AuditOutcome, type Prisma, type UserRole } from "../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { prisma } from "../../config/prisma.js";
import { metrics } from "../../observability/metrics.js";
import { writeAuditEvent } from "../audit/audit.service.js";
import { calculateDispatchScore, estimateStraightLineDistanceMeters, evaluateDriverEligibility } from "./dispatch.scoring.js";

const ACTIVE_DELIVERY_STATUSES = ["ASSIGNED", "PICKED_UP", "IN_TRANSIT"] as const;
const toNumber = (value: number | { toNumber(): number }) => typeof value === "number" ? value : value.toNumber();

interface DispatchCandidateRow {
  driver_id: string;
  latitude: number;
  longitude: number;
  recorded_at: Date;
  active_delivery_count: number;
  vehicle_id: string;
  vehicle_fit_score: number;
}

function weights() {
  return {
    distance: env.DISPATCH_DISTANCE_WEIGHT / 100,
    workload: env.DISPATCH_WORKLOAD_WEIGHT / 100,
    freshness: env.DISPATCH_FRESHNESS_WEIGHT / 100,
    vehicleFit: env.DISPATCH_VEHICLE_FIT_WEIGHT / 100,
  };
}

export async function recommendDrivers(
  deliveryId: string,
  actor: { id: string; role: UserRole },
  limit: number,
) {
  const startedAt = performance.now();
  let failed = true;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const delivery = await tx.delivery.findUnique({
        where: { id: deliveryId },
        select: {
          id: true, status: true, driverId: true, pickupLatitude: true, pickupLongitude: true,
          requiredVehicleType: true, minimumPayloadKg: true, minimumVolumeCubicMeters: true,
          requiresRefrigeratedTransport: true, requiredQualifications: true,
        },
      });
      if (!delivery) throw new Error("DELIVERY_NOT_FOUND");
      if (delivery.status !== "PENDING" && delivery.status !== "ASSIGNED") {
        throw new Error("DELIVERY_CANNOT_BE_ASSIGNED");
      }
      if (delivery.pickupLatitude === null || delivery.pickupLongitude === null) {
        throw new Error("DRIVER_LOCATION_REQUIRED_FOR_DISPATCH");
      }

      const now = new Date();
      const staleAfterSeconds = env.GPS_STALE_AFTER_SECONDS;
      const freshnessCutoff = new Date(now.getTime() - staleAfterSeconds * 1_000);
      const rows = await tx.$queryRaw<DispatchCandidateRow[]>`
        SELECT
          u.id AS driver_id,
          latest.latitude,
          latest.longitude,
          latest.recorded_at,
          workload.active_delivery_count,
          vehicle.id AS vehicle_id,
          CASE WHEN ${delivery.minimumPayloadKg !== null || delivery.minimumVolumeCubicMeters !== null}
            THEN LEAST(100, GREATEST(0, 100 * GREATEST(
              CASE WHEN ${delivery.minimumPayloadKg !== null} THEN ${delivery.minimumPayloadKg === null ? 0 : toNumber(delivery.minimumPayloadKg)} / NULLIF(vehicle.maximum_payload_kg, 0) ELSE 0 END,
              CASE WHEN ${delivery.minimumVolumeCubicMeters !== null} THEN ${delivery.minimumVolumeCubicMeters === null ? 0 : toNumber(delivery.minimumVolumeCubicMeters)} / NULLIF(vehicle.maximum_volume_cubic_meters, 0) ELSE 0 END
            ))) ELSE 100 END AS vehicle_fit_score
        FROM users AS u
        JOIN LATERAL (
          SELECT location.latitude, location.longitude, location.recorded_at
          FROM driver_locations AS location
          WHERE location.driver_id = u.id AND location.recorded_at <= ${now}
          ORDER BY location.recorded_at DESC, location.id DESC
          LIMIT 1
        ) AS latest ON TRUE
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::integer AS active_delivery_count
          FROM deliveries AS active_delivery
          WHERE active_delivery.driver_id = u.id
            AND active_delivery.status IN ('ASSIGNED', 'PICKED_UP', 'IN_TRANSIT')
        ) AS workload
        JOIN driver_vehicle_assignments AS vehicle_assignment
          ON vehicle_assignment.driver_id = u.id AND vehicle_assignment.ended_at IS NULL
        JOIN vehicles AS vehicle ON vehicle.id = vehicle_assignment.vehicle_id AND vehicle.status = 'ACTIVE'::"VehicleStatus"
        JOIN driver_shifts AS shift
          ON shift.driver_id = u.id AND shift.status = 'ACTIVE'::"DriverShiftStatus"
          AND shift.starts_at <= ${now} AND shift.ends_at > ${now}
        WHERE u.role = 'DRIVER'::"UserRole"
          AND u.status = 'ACTIVE'::"UserStatus"
          AND u.availability = 'AVAILABLE'::"DriverAvailability"
          AND latest.recorded_at >= ${freshnessCutoff}
          AND workload.active_delivery_count < ${env.DISPATCH_MAX_ACTIVE_DELIVERIES}
          AND (${delivery.requiredVehicleType}::"VehicleType" IS NULL OR vehicle.type = ${delivery.requiredVehicleType}::"VehicleType")
          AND (${delivery.minimumPayloadKg === null} OR vehicle.maximum_payload_kg >= ${delivery.minimumPayloadKg === null ? 0 : toNumber(delivery.minimumPayloadKg)})
          AND (${delivery.minimumVolumeCubicMeters === null} OR vehicle.maximum_volume_cubic_meters >= ${delivery.minimumVolumeCubicMeters === null ? 0 : toNumber(delivery.minimumVolumeCubicMeters)})
          AND (NOT ${delivery.requiresRefrigeratedTransport} OR vehicle.refrigerated = TRUE)
          AND NOT EXISTS (
            SELECT 1 FROM unnest(${delivery.requiredQualifications}::text[]) AS required(code)
            WHERE NOT EXISTS (
              SELECT 1 FROM driver_qualifications AS qualification
              WHERE qualification.driver_id = u.id AND qualification.qualification_type = required.code
                AND qualification.verification_status = 'VERIFIED'::"QualificationVerificationStatus"
                AND (qualification.expires_at IS NULL OR qualification.expires_at > ${now})
            )
          )
        ORDER BY
          (
            GREATEST(0, 100 * (1 - (
              6371.0088 * 2 * ASIN(LEAST(1, SQRT(
                POWER(SIN(RADIANS(latest.latitude - ${toNumber(delivery.pickupLatitude)}) / 2), 2) +
                COS(RADIANS(${toNumber(delivery.pickupLatitude)})) * COS(RADIANS(latest.latitude)) *
                POWER(SIN(RADIANS(latest.longitude - ${toNumber(delivery.pickupLongitude)}) / 2), 2)
              ))) / ${env.DISPATCH_DISTANCE_NORMALIZATION_KM}
            ))) * ${env.DISPATCH_DISTANCE_WEIGHT} +
            GREATEST(0, 100 * (1 - workload.active_delivery_count::float / ${env.DISPATCH_MAX_ACTIVE_DELIVERIES})) * ${env.DISPATCH_WORKLOAD_WEIGHT} +
            GREATEST(0, 100 * (1 - EXTRACT(EPOCH FROM (${now} - latest.recorded_at)) / ${staleAfterSeconds})) * ${env.DISPATCH_FRESHNESS_WEIGHT} +
            (CASE WHEN ${delivery.minimumPayloadKg !== null || delivery.minimumVolumeCubicMeters !== null} THEN LEAST(100, GREATEST(0, 100 * GREATEST(
              CASE WHEN ${delivery.minimumPayloadKg !== null} THEN ${delivery.minimumPayloadKg === null ? 0 : toNumber(delivery.minimumPayloadKg)} / NULLIF(vehicle.maximum_payload_kg, 0) ELSE 0 END,
              CASE WHEN ${delivery.minimumVolumeCubicMeters !== null} THEN ${delivery.minimumVolumeCubicMeters === null ? 0 : toNumber(delivery.minimumVolumeCubicMeters)} / NULLIF(vehicle.maximum_volume_cubic_meters, 0) ELSE 0 END
            ))) ELSE 100 END) * ${env.DISPATCH_VEHICLE_FIT_WEIGHT}
          ) DESC,
          u.id ASC
        LIMIT ${limit + 1}
      `;

      const hasMore = rows.length > limit;
      const candidates = rows.slice(0, limit).map((row) => {
        const distanceMeters = estimateStraightLineDistanceMeters(
          { latitude: row.latitude, longitude: row.longitude },
          { latitude: toNumber(delivery.pickupLatitude!), longitude: toNumber(delivery.pickupLongitude!) },
        );
        const ageSeconds = Math.max(0, (now.getTime() - row.recorded_at.getTime()) / 1_000);
        const workload = Number(row.active_delivery_count);
        const eligibility = evaluateDriverEligibility({
          accountActive: true,
          roleIsDriver: true,
          workload,
          maxActiveDeliveries: env.DISPATCH_MAX_ACTIVE_DELIVERIES,
          hasFreshLocation: ageSeconds <= staleAfterSeconds,
          pickupCoordinatesAvailable: true,
          deliveryEligible: true,
          availabilityIsAvailable: true,
          hasActiveShift: true,
          hasRequiredQualifications: true,
          hasSuitableVehicle: true,
        });
        const scores = calculateDispatchScore({
          distanceMeters,
          workload,
          gpsAgeSeconds: ageSeconds,
          gpsStaleAfterSeconds: staleAfterSeconds,
          maxActiveDeliveries: env.DISPATCH_MAX_ACTIVE_DELIVERIES,
          distanceNormalizationKm: env.DISPATCH_DISTANCE_NORMALIZATION_KM,
          weights: weights(),
          vehicleFitScore: Number(row.vehicle_fit_score),
        });
        return {
          driverId: row.driver_id,
          eligible: eligibility.eligible,
          score: scores.score,
          distanceEstimate: { meters: Math.round(distanceMeters), method: "STRAIGHT_LINE_APPROXIMATION" as const },
          workload: { activeDeliveries: workload, limit: env.DISPATCH_MAX_ACTIVE_DELIVERIES },
          gpsAgeSeconds: Math.floor(ageSeconds),
          explanation: `Distance ${scores.distanceScore}/100; workload ${scores.workloadScore}/100; GPS freshness ${scores.freshnessScore}/100; vehicle fit ${scores.vehicleFitScore}/100. Weights: ${env.DISPATCH_DISTANCE_WEIGHT}% / ${env.DISPATCH_WORKLOAD_WEIGHT}% / ${env.DISPATCH_FRESHNESS_WEIGHT}% / ${env.DISPATCH_VEHICLE_FIT_WEIGHT}%.`,
        };
      });

      await writeAuditEvent(tx, {
        actor: { userId: actor.id, role: actor.role },
        action: "dispatch.recommendations",
        resourceType: "delivery",
        resourceId: delivery.id,
        outcome: AuditOutcome.SUCCESS,
      });
      return {
        deliveryId: delivery.id,
        advisoryOnly: true,
        candidates: candidates.map((candidate, index) => ({ ...candidate, rankingPosition: index + 1 })),
        pagination: { limit, returned: candidates.length, hasMore },
      };
    }, { isolationLevel: "RepeatableRead" });
    failed = false;
    return result;
  } finally {
    metrics.recordDispatchRecommendation(performance.now() - startedAt, failed);
  }
}

/** Called inside the assignment transaction, after locking this driver's assignment slot. */
export async function revalidateDriverForAssignment(
  tx: Prisma.TransactionClient,
  driverId: string,
  delivery: {
    id: string; pickupLatitude: Prisma.Decimal | null; pickupLongitude: Prisma.Decimal | null;
    requiredVehicleType: string | null; minimumPayloadKg: Prisma.Decimal | null;
    minimumVolumeCubicMeters: Prisma.Decimal | null; requiresRefrigeratedTransport: boolean;
    requiredQualifications: string[];
  },
) {
  await tx.$queryRaw<Array<{ locked: number }>>`
    WITH lock_result AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${`dispatch-driver:${driverId}`}, 0))
    )
    SELECT 1::integer AS locked FROM lock_result
  `;
  const driver = await tx.user.findFirst({
    where: { id: driverId, role: "DRIVER", status: "ACTIVE" },
    select: { id: true, availability: true },
  });
  if (!driver) throw new Error("DRIVER_NOT_FOUND_OR_INACTIVE");
  if (driver.availability !== "AVAILABLE") throw new Error("DRIVER_UNAVAILABLE");

  const workload = await tx.delivery.count({
    where: {
      driverId,
      id: { not: delivery.id },
      status: { in: [...ACTIVE_DELIVERY_STATUSES] },
    },
  });
  const hasPickupLocation = delivery.pickupLatitude !== null && delivery.pickupLongitude !== null;
  let hasFreshLocation = !hasPickupLocation;
  if (hasPickupLocation) {
    const location = await tx.driverLocation.findFirst({
      where: { driverId, recordedAt: { gte: new Date(Date.now() - env.GPS_STALE_AFTER_SECONDS * 1_000) } },
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    hasFreshLocation = location !== null;
  }
  const now = new Date();
  const [activeShift, assignment] = await Promise.all([
    tx.driverShift.findFirst({ where: { driverId, status: "ACTIVE", startsAt: { lte: now }, endsAt: { gt: now } }, select: { id: true } }),
    tx.driverVehicleAssignment.findFirst({ where: { driverId, endedAt: null }, include: { vehicle: true } }),
  ]);
  if (!activeShift) throw new Error("DRIVER_NO_ACTIVE_SHIFT");
  if (!assignment || assignment.vehicle.status !== "ACTIVE") throw new Error("DRIVER_NO_SUITABLE_VEHICLE");
  const vehicle = assignment.vehicle;
  if (delivery.requiredVehicleType && delivery.requiredVehicleType !== vehicle.type) throw new Error("DRIVER_NO_SUITABLE_VEHICLE");
  if (delivery.minimumPayloadKg && Number(vehicle.maximumPayloadKg) < Number(delivery.minimumPayloadKg)) throw new Error("DRIVER_NO_SUITABLE_VEHICLE");
  if (delivery.minimumVolumeCubicMeters && (vehicle.maximumVolumeCubicMeters === null || Number(vehicle.maximumVolumeCubicMeters) < Number(delivery.minimumVolumeCubicMeters))) throw new Error("DRIVER_NO_SUITABLE_VEHICLE");
  if (delivery.requiresRefrigeratedTransport && !vehicle.refrigerated) throw new Error("DRIVER_NO_SUITABLE_VEHICLE");
  const qualifications = delivery.requiredQualifications.length
    ? await tx.driverQualification.findMany({ where: { driverId, qualificationType: { in: delivery.requiredQualifications }, verificationStatus: "VERIFIED", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, select: { qualificationType: true } })
    : [];
  if (delivery.requiredQualifications.some((code) => !qualifications.some((qualification) => qualification.qualificationType === code))) {
    throw new Error("DRIVER_MISSING_REQUIRED_QUALIFICATION");
  }
  const eligibility = evaluateDriverEligibility({
    accountActive: true,
    roleIsDriver: true,
    workload,
    maxActiveDeliveries: env.DISPATCH_MAX_ACTIVE_DELIVERIES,
    hasFreshLocation,
    pickupCoordinatesAvailable: hasPickupLocation,
    deliveryEligible: true,
    availabilityIsAvailable: driver.availability === "AVAILABLE",
    hasActiveShift: true,
    hasRequiredQualifications: true,
    hasSuitableVehicle: true,
  });
  if (!eligibility.eligible) {
    if (eligibility.reasons.includes("workload_limit_reached")) throw new Error("DRIVER_WORKLOAD_LIMIT_REACHED");
    if (eligibility.reasons.includes("fresh_location_required")) throw new Error("DRIVER_GPS_STALE_FOR_DISPATCH");
    throw new Error("DRIVER_NOT_FOUND_OR_INACTIVE");
  }
  return { vehicleId: vehicle.id };
}
