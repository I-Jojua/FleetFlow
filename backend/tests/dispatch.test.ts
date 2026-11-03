import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateDispatchScore, estimateStraightLineDistanceMeters, evaluateDriverEligibility } from "../src/modules/dispatch/dispatch.scoring.js";
import { dispatchRecommendationQuerySchema } from "../src/modules/dispatch/dispatch.validation.js";
import { RATE_LIMIT_POLICIES } from "../src/middleware/rate-limit.middleware.js";
import { createMetricsRecorder } from "../src/observability/metrics.js";
import { validateEnvironment } from "../src/config/env.js";

test("dispatch eligibility rejects inactive, unavailable, overloaded, stale, or unlocated drivers", () => {
  const baseline = {
    accountActive: true,
    roleIsDriver: true,
    workload: 2,
    maxActiveDeliveries: 5,
    hasFreshLocation: true,
    pickupCoordinatesAvailable: true,
    deliveryEligible: true,
  };
  assert.equal(evaluateDriverEligibility(baseline).eligible, true);
  assert.deepEqual(evaluateDriverEligibility({ ...baseline, accountActive: false }).reasons, ["account_inactive"]);
  assert.deepEqual(evaluateDriverEligibility({ ...baseline, roleIsDriver: false }).reasons, ["not_a_driver"]);
  assert.deepEqual(evaluateDriverEligibility({ ...baseline, workload: 5 }).reasons, ["workload_limit_reached"]);
  assert.deepEqual(evaluateDriverEligibility({ ...baseline, hasFreshLocation: false }).reasons, ["fresh_location_required"]);
  assert.equal(evaluateDriverEligibility({ ...baseline, pickupCoordinatesAvailable: false, hasFreshLocation: false }).eligible, true);
});

test("dispatch scoring is transparent and straight-line distance is explicitly approximate", () => {
  const score = calculateDispatchScore({
    distanceMeters: 0,
    workload: 0,
    gpsAgeSeconds: 0,
    gpsStaleAfterSeconds: 120,
    maxActiveDeliveries: 5,
    distanceNormalizationKm: 100,
    weights: { distance: 0.6, workload: 0.25, freshness: 0.15 },
  });
  assert.deepEqual(score, { score: 100, distanceScore: 100, workloadScore: 100, freshnessScore: 100, vehicleFitScore: 100 });
  assert.equal(estimateStraightLineDistanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) > 111_000, true);
});

test("dispatch query bounds candidate output and has a dedicated rate limit", () => {
  assert.equal(dispatchRecommendationQuerySchema.parse({}).limit, 10);
  assert.equal(dispatchRecommendationQuerySchema.parse({ limit: "50" }).limit, 50);
  assert.equal(dispatchRecommendationQuerySchema.safeParse({ limit: 51 }).success, false);
  assert.equal(RATE_LIMIT_POLICIES.dispatchRecommendations.maxRequests, 30);
});

test("dispatch scoring configuration is validated and weights must sum to 100", () => {
  const valid = validateEnvironment({ DISPATCH_DISTANCE_WEIGHT: "50", DISPATCH_WORKLOAD_WEIGHT: "30", DISPATCH_FRESHNESS_WEIGHT: "20", DISPATCH_VEHICLE_FIT_WEIGHT: "0" });
  assert.equal(valid.DISPATCH_DISTANCE_WEIGHT, 50);
  assert.throws(() => validateEnvironment({ DISPATCH_DISTANCE_WEIGHT: "50", DISPATCH_WORKLOAD_WEIGHT: "30", DISPATCH_FRESHNESS_WEIGHT: "15", DISPATCH_VEHICLE_FIT_WEIGHT: "0" }), /DISPATCH_DISTANCE_WEIGHT/);
  assert.equal(validateEnvironment({ DISPATCH_DISTANCE_WEIGHT: "50", DISPATCH_WORKLOAD_WEIGHT: "25", DISPATCH_FRESHNESS_WEIGHT: "15", DISPATCH_VEHICLE_FIT_WEIGHT: "10" }).DISPATCH_VEHICLE_FIT_WEIGHT, 10);
});

test("dispatch eligibility requires workforce availability, active shifts, qualifications, and vehicle fit", () => {
  const baseline = { accountActive: true, roleIsDriver: true, workload: 0, maxActiveDeliveries: 5, hasFreshLocation: true, pickupCoordinatesAvailable: true, deliveryEligible: true, availabilityIsAvailable: true, hasActiveShift: true, hasRequiredQualifications: true, hasSuitableVehicle: true };
  assert.equal(evaluateDriverEligibility({ ...baseline, availabilityIsAvailable: false }).reasons[0], "driver_unavailable");
  assert.equal(evaluateDriverEligibility({ ...baseline, hasActiveShift: false }).reasons[0], "no_active_shift");
  assert.equal(evaluateDriverEligibility({ ...baseline, hasRequiredQualifications: false }).reasons[0], "missing_required_qualification");
  assert.equal(evaluateDriverEligibility({ ...baseline, hasSuitableVehicle: false }).reasons[0], "no_suitable_vehicle");
});

test("dispatch metrics report counts, failures, and duration without per-driver labels", () => {
  const recorder = createMetricsRecorder();
  recorder.recordDispatchRecommendation(12.5);
  recorder.recordDispatchRecommendation(4, true);
  assert.deepEqual(recorder.snapshot().dispatch, {
    recommendations: 1,
    failures: 1,
    durationMs: { count: 2, sum: 16.5, max: 12.5 },
  });
});
