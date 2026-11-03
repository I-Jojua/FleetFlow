import assert from "node:assert/strict";
import { test } from "node:test";
import { createShiftSchema, createQualificationSchema, shiftListQuerySchema, updateAvailabilitySchema } from "../src/modules/drivers/workforce.validation.js";
import { createVehicleSchema, vehicleListQuerySchema } from "../src/modules/vehicles/vehicle.validation.js";
import { updateDeliveryRequirementsSchema } from "../src/modules/deliveries/delivery.validation.js";
import { errorHandler } from "../src/middleware/error.middleware.js";
import { RATE_LIMIT_POLICIES } from "../src/middleware/rate-limit.middleware.js";
import type { Request, Response } from "express";

test("workforce schemas normalize identifiers and require offset dates, IANA zones, and positive pagination", () => {
  assert.equal(createQualificationSchema.parse({ qualificationType: " forklift-A " }).qualificationType, "FORKLIFT-A");
  assert.equal(createQualificationSchema.safeParse({ qualificationType: "license", issuedAt: "2026-02-01T09:00:00" }).success, false);
  assert.equal(createShiftSchema.safeParse({ startsAt: "2026-02-01T09:00:00Z", endsAt: "2026-02-01T08:00:00Z", timezone: "Etc/UTC" }).success, false);
  assert.equal(createShiftSchema.safeParse({ startsAt: "2026-02-01T09:00:00Z", endsAt: "2026-02-01T10:00:00Z", timezone: "Not/AZone" }).success, false);
  assert.equal(shiftListQuerySchema.safeParse({ page: "0" }).success, false);
  assert.equal(updateAvailabilitySchema.safeParse({ availability: "DRIVING" }).success, false);
});

test("vehicle and delivery requirements validate capacity bounds and reject duplicate required skills", () => {
  assert.equal(createVehicleSchema.safeParse({ registrationIdentifier: "ff 01", type: "VAN", maximumPayloadKg: 1 }).success, true);
  assert.equal(createVehicleSchema.safeParse({ registrationIdentifier: "ff 01", type: "VAN", maximumPayloadKg: 0 }).success, false);
  assert.equal(vehicleListQuerySchema.safeParse({ limit: "101" }).success, false);
  assert.equal(updateDeliveryRequirementsSchema.safeParse({ requiredQualifications: ["FORKLIFT", "forklift"] }).success, false);
  const requirements = updateDeliveryRequirementsSchema.parse({ requiredQualifications: ["forklift"], minimumPayloadKg: 250, requiresRefrigeratedTransport: true });
  assert.deepEqual(requirements.requiredQualifications, ["FORKLIFT"]);
});

test("workforce routes use dedicated read and write rate limits and state conflicts map to 409", () => {
  assert.equal(RATE_LIMIT_POLICIES.workforceRead.maxRequests, 120);
  assert.equal(RATE_LIMIT_POLICIES.workforceWrite.maxRequests, 30);
  let statusCode = 200;
  const response = { status(code: number) { statusCode = code; return this; }, json() { return this; } };
  errorHandler(new Error("DRIVER_SHIFT_OVERLAP"), {} as Request, response as unknown as Response, () => undefined);
  assert.equal(statusCode, 409);
});
