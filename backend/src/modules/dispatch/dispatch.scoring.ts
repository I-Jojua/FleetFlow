export interface DispatchScoreParts {
  distanceMeters: number;
  workload: number;
  gpsAgeSeconds: number;
  gpsStaleAfterSeconds: number;
  maxActiveDeliveries: number;
  distanceNormalizationKm: number;
  weights: { distance: number; workload: number; freshness: number; vehicleFit?: number };
  vehicleFitScore?: number;
}

export interface DriverEligibilityInput {
  accountActive: boolean;
  roleIsDriver: boolean;
  workload: number;
  maxActiveDeliveries: number;
  hasFreshLocation: boolean;
  pickupCoordinatesAvailable: boolean;
  deliveryEligible: boolean;
  availabilityIsAvailable?: boolean;
  hasActiveShift?: boolean;
  hasRequiredQualifications?: boolean;
  hasSuitableVehicle?: boolean;
}

export function evaluateDriverEligibility(input: DriverEligibilityInput) {
  const reasons: string[] = [];
  if (!input.accountActive) reasons.push("account_inactive");
  if (!input.roleIsDriver) reasons.push("not_a_driver");
  if (!input.deliveryEligible) reasons.push("delivery_not_assignable");
  if (input.availabilityIsAvailable === false) reasons.push("driver_unavailable");
  if (input.hasActiveShift === false) reasons.push("no_active_shift");
  if (input.hasRequiredQualifications === false) reasons.push("missing_required_qualification");
  if (input.hasSuitableVehicle === false) reasons.push("no_suitable_vehicle");
  if (input.workload >= input.maxActiveDeliveries) reasons.push("workload_limit_reached");
  if (input.pickupCoordinatesAvailable && !input.hasFreshLocation) reasons.push("fresh_location_required");
  return { eligible: reasons.length === 0, reasons };
}

export function calculateDispatchScore(parts: DispatchScoreParts): {
  score: number;
  distanceScore: number;
  workloadScore: number;
  freshnessScore: number;
  vehicleFitScore: number;
} {
  const distanceKm = parts.distanceMeters / 1_000;
  const distanceScore = Math.max(0, 100 * (1 - distanceKm / parts.distanceNormalizationKm));
  const workloadScore = Math.max(0, 100 * (1 - parts.workload / parts.maxActiveDeliveries));
  const freshnessScore = Math.max(0, 100 * (1 - parts.gpsAgeSeconds / parts.gpsStaleAfterSeconds));
  const vehicleFitScore = parts.vehicleFitScore ?? 100;
  const weighted =
    distanceScore * parts.weights.distance +
    workloadScore * parts.weights.workload +
    freshnessScore * parts.weights.freshness +
    vehicleFitScore * (parts.weights.vehicleFit ?? 0);
  return {
    score: Math.round(weighted * 100) / 100,
    distanceScore: Math.round(distanceScore),
    workloadScore: Math.round(workloadScore),
    freshnessScore: Math.round(freshnessScore),
    vehicleFitScore: Math.round(vehicleFitScore),
  };
}

/** Haversine distance between coordinates. This is a straight-line approximation, not road distance. */
export function estimateStraightLineDistanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
