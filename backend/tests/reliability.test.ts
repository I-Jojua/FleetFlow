import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ZodError } from "zod";
import type { Request, Response } from "express";

import { env } from "../src/config/env.js";
import { prisma } from "../src/config/prisma.js";
import { errorHandler } from "../src/middleware/error.middleware.js";
import { validateUuidParam } from "../src/middleware/request-validation.js";
import * as deliveryController from "../src/modules/deliveries/delivery.controller.js";
import * as deliveryService from "../src/modules/deliveries/delivery.service.js";
import { deliveryQuerySchema, locationHistoryQuerySchema } from "../src/modules/deliveries/delivery.validation.js";
import { updateDriverLocationSchema } from "../src/modules/deliveries/delivery.validation.js";
import { activeDriverLocationsQuerySchema } from "../src/modules/drivers/driver.validation.js";
import { RATE_LIMIT_POLICIES } from "../src/middleware/rate-limit.middleware.js";
import { createLocationRetentionWorker } from "../src/modules/deliveries/location-retention.js";
import * as driverService from "../src/modules/drivers/driver.service.js";
import { notificationQuerySchema } from "../src/modules/notifications/notification.validation.js";
import { validateEnvironment } from "../src/config/env.js";

const customerId = "00000000-0000-4000-8000-000000000001";
const driverId = "00000000-0000-4000-8000-000000000002";
const previousDriverId = "00000000-0000-4000-8000-000000000005";
const deliveryId = "00000000-0000-4000-8000-000000000003";
const notificationId = "00000000-0000-4000-8000-000000000004";

function replaceMethod(
  t: TestContext,
  target: Record<string, any>,
  methodName: string,
  implementation: (...args: any[]) => unknown,
) {
  const original = target[methodName];
  target[methodName] = implementation;
  t.after(() => {
    target[methodName] = original;
  });
}

function mockTransaction(
  t: TestContext,
  transactionClient: object,
  capture?: { options?: { isolationLevel?: string } },
) {
  replaceMethod(t, prisma, "$transaction", async (
    callback: (tx: object) => unknown,
    options?: { isolationLevel?: string },
  ) => {
    if (capture) capture.options = options;
    const tx = transactionClient as Record<string, any>;
    tx.$queryRaw ??= async () => [];
    tx.delivery ??= {};
    tx.delivery.count ??= async () => 0;
    tx.user ??= { findFirst: async () => ({ id: driverId, availability: "AVAILABLE" }) };
    tx.driverShift ??= { findFirst: async () => ({ id: "test-shift" }) };
    tx.driverVehicleAssignment ??= { findFirst: async () => ({ vehicleId: "test-vehicle", vehicle: { id: "test-vehicle", status: "ACTIVE", type: "VAN", maximumPayloadKg: 1000, maximumVolumeCubicMeters: 10, refrigerated: false } }) };
    tx.driverQualification ??= { findMany: async () => [] };
    tx.auditLog ??= { create: async ({ data }: { data: unknown }) => ({ id: "audit-test-record", ...data as object }) };
    return callback(tx);
  });
}

function setSlackDisabled(t: TestContext) {
  const previousValue = env.SLACK_WEBHOOK_URL;
  env.SLACK_WEBHOOK_URL = undefined;
  t.after(() => {
    env.SLACK_WEBHOOK_URL = previousValue;
  });
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: deliveryId,
    trackingCode: "FF-RELIABILITY",
    customerId,
    driverId: null as string | null,
    status: "PENDING",
    recipientName: "Test Recipient",
    recipientPhone: "+995555000000",
    pickupAddress: "Test pickup address",
    pickupLatitude: null,
    pickupLongitude: null,
    deliveryAddress: "Test delivery address",
    deliveryLatitude: null,
    deliveryLongitude: null,
    packageDescription: null,
    packageWeight: null,
    requiredVehicleType: null,
    minimumPayloadKg: null,
    minimumVolumeCubicMeters: null,
    requiresRefrigeratedTransport: false,
    requiredQualifications: [],
    notes: null,
    assignedAt: null,
    pickedUpAt: null,
    deliveredAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function responseSpy() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    get statusCode() { return statusCode; },
    get body() { return body; },
    setHeader() { return response; },
    status(code: number) { statusCode = code; return response; },
    json(value: unknown) { body = value; return response; },
    destroy() {},
  };
  return response;
}

function safeErrorResponse(error: unknown) {
  const res = responseSpy();
  errorHandler(error, {} as Request, res as unknown as Response, () => undefined);
  return res;
}

test("Prisma unique, not-found, and Zod errors map to safe 409, 404, and 400 JSON responses", () => {
  const unique = safeErrorResponse({ code: "P2002", message: "private unique value" });
  const missing = safeErrorResponse({ code: "P2025", message: "private record detail" });
  const domainMissing = safeErrorResponse(new Error("CUSTOMER_NOT_FOUND"));
  const forbidden = safeErrorResponse(new Error("DELIVERY_FORBIDDEN"));
  const activeWork = safeErrorResponse(new Error("DRIVER_HAS_ACTIVE_DELIVERIES"));
  const validation = safeErrorResponse(new ZodError([
    { code: "custom", path: ["page"], message: "Must be a positive integer." },
  ]));

  assert.equal(unique.statusCode, 409);
  assert.equal((unique.body as { code: string }).code, "CONFLICT");
  assert.equal(missing.statusCode, 404);
  assert.equal((missing.body as { code: string }).code, "NOT_FOUND");
  assert.equal(domainMissing.statusCode, 404);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(activeWork.statusCode, 409);
  assert.equal(validation.statusCode, 400);
  assert.equal((validation.body as { code: string }).code, "VALIDATION_FAILED");
  assert.doesNotMatch(JSON.stringify(unique.body), /private unique value/);
  assert.doesNotMatch(JSON.stringify(missing.body), /private record detail/);
});

test("all delivery, location, and notification pagination schemas reject non-positive or fractional values", () => {
  for (const schema of [deliveryQuerySchema, locationHistoryQuerySchema, notificationQuerySchema]) {
    assert.equal(schema.safeParse({ page: "1.5" }).success, false);
    assert.equal(schema.safeParse({ page: "0" }).success, false);
    assert.equal(schema.safeParse({ limit: "-1" }).success, false);
    assert.equal(schema.safeParse({ limit: "1.25" }).success, false);
  }

  assert.deepEqual(locationHistoryQuerySchema.parse({ page: "2", limit: "50" }), {
    page: 2,
    limit: 50,
  });
  assert.equal(locationHistoryQuerySchema.safeParse({ from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" }).success, false);
  assert.deepEqual(activeDriverLocationsQuerySchema.parse({}), { page: 1, limit: 25 });
});

test("GPS input validates ranges, timestamp format, and applies dedicated rate-limit policies", () => {
  assert.equal(updateDriverLocationSchema.safeParse({
    latitude: 40.7,
    longitude: -74,
    accuracy: 12,
    timestamp: "2026-11-03T12:00:00Z",
  }).success, true);
  assert.equal(updateDriverLocationSchema.safeParse({ latitude: 90.1, longitude: 0 }).success, false);
  assert.equal(updateDriverLocationSchema.safeParse({ latitude: 0, longitude: 180.1 }).success, false);
  assert.equal(updateDriverLocationSchema.safeParse({ latitude: 0, longitude: 0, accuracy: 100_001 }).success, false);
  assert.equal(updateDriverLocationSchema.safeParse({ latitude: "", longitude: 0 }).success, false);
  assert.equal(updateDriverLocationSchema.safeParse({ latitude: 0, longitude: 0, timestamp: "not-a-time" }).success, false);
  assert.deepEqual(RATE_LIMIT_POLICIES.driverLocationUpdate, {
    key: "driver-location-update", windowMs: 60_000, maxRequests: 60,
  });
  assert.deepEqual(RATE_LIMIT_POLICIES.activeDriverLocations, {
    key: "active-driver-locations", windowMs: 60_000, maxRequests: 30,
  });
  assert.equal(locationHistoryQuerySchema.safeParse({
    from: "2026-01-01T10:00:00-14:00",
    to: "2026-01-01T23:30:00Z",
  }).success, false);
  assert.equal(locationHistoryQuerySchema.safeParse({
    from: "2026-01-01T00:00:00Z",
    to: "2026-04-02T00:00:00Z",
  }).success, false);
});

test("realtime resource-limit environment values are bounded and have practical defaults", () => {
  const config = validateEnvironment({
    NODE_ENV: "test",
    JWT_ACCESS_SECRET: "test_access_secret_that_is_long_enough",
    JWT_REFRESH_SECRET: "test_refresh_secret_that_is_long_enough",
  });
  assert.equal(config.REALTIME_MAX_CONNECTIONS, 1_000);
  assert.equal(config.REALTIME_MAX_CONNECTIONS_PER_IP, 50);
  assert.equal(config.REALTIME_MAX_BUFFERED_BYTES, 1_048_576);
  assert.equal(config.REALTIME_PUBLISH_TIMEOUT_MS, 750);
  assert.throws(() => validateEnvironment({
    NODE_ENV: "test",
    JWT_ACCESS_SECRET: "test_access_secret_that_is_long_enough",
    JWT_REFRESH_SECRET: "test_refresh_secret_that_is_long_enough",
    REALTIME_MAX_CONNECTIONS: "0",
  }), /Invalid environment variables: REALTIME_MAX_CONNECTIONS/);
});

test("GPS retention worker prunes only before the configured cutoff and coalesces overlapping runs", async () => {
  let calls = 0;
  let release: ((count: number) => void) | undefined;
  let cutoff: Date | undefined;
  const worker = createLocationRetentionWorker({
    deleteBefore: (value) => {
      calls += 1;
      cutoff = value;
      return new Promise<number>((resolve) => { release = resolve; });
    },
    retentionDays: 30,
    now: () => new Date("2026-11-03T12:00:00Z"),
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
  });

  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(calls, 1);
  assert.equal(cutoff?.toISOString(), "2026-10-04T12:00:00.000Z");
  release?.(4);
  await Promise.all([first, second]);
  await worker.close();
});

test("UUID route parameter helper returns a consistent 400 for malformed IDs", () => {
  const res = responseSpy();
  const id = validateUuidParam(
    { params: { id: "not-a-uuid" } } as unknown as Request,
    res as unknown as Response,
    "Delivery",
  );

  assert.equal(id, null);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    success: false,
    code: "INVALID_IDENTIFIER",
    message: "Invalid Delivery ID.",
  });
});

test("staff-created delivery is associated with the selected active customer", async (t) => {
  setSlackDisabled(t);
  let persistedCustomerId: string | undefined;
  let eventActorId: string | undefined;
  const created = delivery();
  mockTransaction(t, {
    user: {
      findFirst: async (args: { where: { id: string; role: string; status: string } }) => {
        assert.deepEqual(args.where, { id: customerId, role: "CUSTOMER", status: "ACTIVE" });
        return { id: customerId };
      },
    },
    delivery: {
      create: async (args: { data: { customerId: string } }) => {
        persistedCustomerId = args.data.customerId;
        return created;
      },
    },
    deliveryEvent: {
      create: async (args: { data: { actorId: string } }) => {
        eventActorId = args.data.actorId;
        return {};
      },
    },
  });
  replaceMethod(t, prisma.notification, "create", async () => ({ id: notificationId }));

  const res = responseSpy();
  await deliveryController.createDelivery(
    {
      user: { id: driverId, role: "ADMIN" },
      body: {
        customerId,
        recipientName: "Test Recipient",
        recipientPhone: "+995555000000",
        pickupAddress: "Test pickup address",
        deliveryAddress: "Test delivery address",
      },
    } as unknown as Request,
    res as unknown as Response,
    () => undefined,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(persistedCustomerId, customerId);
  assert.equal(eventActorId, driverId);
});

test("customer cannot create a delivery for a different customer", async () => {
  const res = responseSpy();
  await deliveryController.createDelivery(
    {
      user: { id: customerId, role: "CUSTOMER" },
      body: {
        customerId: driverId,
        recipientName: "Test Recipient",
        recipientPhone: "+995555000000",
        pickupAddress: "Test pickup address",
        deliveryAddress: "Test delivery address",
      },
    } as unknown as Request,
    res as unknown as Response,
    () => undefined,
  );

  assert.equal(res.statusCode, 403);
  assert.equal((res.body as { code: string }).code, "FORBIDDEN");
});

test("staff delivery creation requires a validated customer ID", async () => {
  const res = responseSpy();
  await deliveryController.createDelivery(
    {
      user: { id: driverId, role: "ADMIN" },
      body: {
        recipientName: "Test Recipient",
        recipientPhone: "+995555000000",
        pickupAddress: "Test pickup address",
        deliveryAddress: "Test delivery address",
      },
    } as unknown as Request,
    res as unknown as Response,
    () => undefined,
  );

  assert.equal(res.statusCode, 400);
  assert.equal((res.body as { code: string }).code, "VALIDATION_FAILED");
});

test("driver role cannot assign or reassign a delivery", async () => {
  const res = responseSpy();
  await deliveryController.assignDriver(
    {
      user: { id: driverId, role: "DRIVER" },
      params: { id: deliveryId },
      body: { driverId: customerId },
    } as unknown as Request,
    res as unknown as Response,
    () => undefined,
  );

  assert.equal(res.statusCode, 403);
  assert.equal((res.body as { code: string }).code, "FORBIDDEN");
});

test("driver assignment notifies the previous driver when reassigning", async (t) => {
  setSlackDisabled(t);
  const current = delivery({ driverId: previousDriverId, status: "ASSIGNED" });
  const reassigned = delivery({ driverId, status: "ASSIGNED" });
  const notifications: Array<{ userId: string; title: string }> = [];
  let findUniqueCalls = 0;
  const transactionCapture: { options?: { isolationLevel?: string } } = {};
  mockTransaction(t, {
    delivery: {
      findUnique: async () => findUniqueCalls++ === 0 ? current : reassigned,
      updateMany: async (args: { where: { driverId: string; status: string } }) => {
        assert.equal(args.where.driverId, previousDriverId);
        assert.equal(args.where.status, "ASSIGNED");
        return { count: 1 };
      },
    },
    user: { findFirst: async () => ({ id: driverId, firstName: "New", lastName: "Driver", availability: "AVAILABLE" }) },
    deliveryEvent: { create: async () => ({}) },
  }, transactionCapture);
  replaceMethod(t, prisma.notification, "create", async (args: { data: { userId: string; title: string } }) => {
    notifications.push(args.data);
    return args.data;
  });

  await deliveryService.assignDriver(deliveryId, driverId, customerId, "ADMIN");

  assert.equal(notifications.length, 3);
  assert.ok(notifications.some((item) => item.userId === previousDriverId && item.title === "Delivery reassigned"));
  assert.equal(transactionCapture.options?.isolationLevel, "Serializable");
});

test("delivery assignment rejects non-staff callers at the service boundary", async () => {
  await assert.rejects(
    deliveryService.assignDriver(deliveryId, driverId, driverId, "DRIVER"),
    { message: "DELIVERY_FORBIDDEN" },
  );
});

test("invalid delivery state transitions do not update or append events", async (t) => {
  let updateCalls = 0;
  let eventCalls = 0;
  mockTransaction(t, {
    delivery: {
      findUnique: async () => delivery({ status: "PENDING" }),
      updateMany: async () => { updateCalls += 1; return { count: 1 }; },
    },
    deliveryEvent: { create: async () => { eventCalls += 1; return {}; } },
  });

  await assert.rejects(
    deliveryService.updateDeliveryStatus(
      deliveryId,
      { id: driverId, role: "ADMIN" },
      "DELIVERED",
    ),
    { message: "INVALID_STATUS_TRANSITION" },
  );
  assert.equal(updateCalls, 0);
  assert.equal(eventCalls, 0);
});

test("only one concurrent delivery status transition wins its compare-and-set", async (t) => {
  setSlackDisabled(t);
  let findUniqueCalls = 0;
  let compareAndSetCalls = 0;
  let eventCalls = 0;
  let notificationCalls = 0;
  const current = delivery({ driverId, status: "IN_TRANSIT" });
  const completed = delivery({ driverId, status: "DELIVERED" });
  mockTransaction(t, {
    delivery: {
      findUnique: async () => findUniqueCalls++ < 2 ? current : completed,
      updateMany: async (args: { where: { status: string; driverId: string } }) => {
        assert.equal(args.where.status, "IN_TRANSIT");
        assert.equal(args.where.driverId, driverId);
        compareAndSetCalls += 1;
        return { count: compareAndSetCalls === 1 ? 1 : 0 };
      },
    },
    deliveryEvent: { create: async () => { eventCalls += 1; return {}; } },
  });
  replaceMethod(t, prisma.notification, "create", async () => {
    notificationCalls += 1;
    return { id: notificationId };
  });

  const results = await Promise.allSettled([
    deliveryService.updateDeliveryStatus(deliveryId, { id: driverId, role: "DRIVER" }, "DELIVERED"),
    deliveryService.updateDeliveryStatus(deliveryId, { id: driverId, role: "DRIVER" }, "DELIVERED"),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const failure = results.find((result) => result.status === "rejected");
  assert.equal((failure as PromiseRejectedResult).reason.message, "DELIVERY_STATE_CONFLICT");
  assert.equal(compareAndSetCalls, 2);
  assert.equal(eventCalls, 1);
  assert.equal(notificationCalls, 2);
});

const validStatusTransitions = [
  ["PENDING", "CANCELLED"],
  ["ASSIGNED", "PICKED_UP"],
  ["ASSIGNED", "CANCELLED"],
  ["PICKED_UP", "IN_TRANSIT"],
  ["IN_TRANSIT", "DELIVERED"],
] as const;

for (const [fromStatus, toStatus] of validStatusTransitions) {
  test(`allowed transition ${fromStatus} -> ${toStatus} updates atomically`, async (t) => {
    setSlackDisabled(t);
    let findUniqueCalls = 0;
    let compareAndSetCalls = 0;
    let eventCalls = 0;
    const current = delivery({
      status: fromStatus,
      driverId: fromStatus === "PENDING" ? null : driverId,
    });
    const updated = delivery({
      status: toStatus,
      driverId: current.driverId,
    });
    mockTransaction(t, {
      delivery: {
        findUnique: async () => findUniqueCalls++ === 0 ? current : updated,
        updateMany: async (args: { where: { status: string } }) => {
          assert.equal(args.where.status, fromStatus);
          compareAndSetCalls += 1;
          return { count: 1 };
        },
      },
      deliveryEvent: { create: async () => { eventCalls += 1; return {}; } },
    });
    replaceMethod(t, prisma.notification, "create", async () => ({ id: notificationId }));

    const result = await deliveryService.updateDeliveryStatus(
      deliveryId,
      { id: driverId, role: "ADMIN" },
      toStatus,
    );

    assert.equal(result.status, toStatus);
    assert.equal(compareAndSetCalls, 1);
    assert.equal(eventCalls, 1);
  });
}

test("concurrent driver assignments cannot overwrite one another", async (t) => {
  setSlackDisabled(t);
  let findUniqueCalls = 0;
  let compareAndSetCalls = 0;
  let eventCalls = 0;
  let notificationCalls = 0;
  const current = delivery();
  const assigned = delivery({ status: "ASSIGNED", driverId });
  mockTransaction(t, {
    delivery: {
      findUnique: async () => findUniqueCalls++ < 2 ? current : assigned,
      updateMany: async () => {
        compareAndSetCalls += 1;
        return { count: compareAndSetCalls === 1 ? 1 : 0 };
      },
    },
    user: { findFirst: async () => ({ id: driverId, firstName: "Test", lastName: "Driver", availability: "AVAILABLE" }) },
    deliveryEvent: { create: async () => { eventCalls += 1; return {}; } },
  });
  replaceMethod(t, prisma.notification, "create", async () => {
    notificationCalls += 1;
    return { id: notificationId };
  });

  const results = await Promise.allSettled([
    deliveryService.assignDriver(deliveryId, driverId, customerId, "ADMIN"),
    deliveryService.assignDriver(deliveryId, driverId, customerId, "ADMIN"),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const failure = results.find((result) => result.status === "rejected");
  assert.equal((failure as PromiseRejectedResult).reason.message, "DELIVERY_STATE_CONFLICT");
  assert.equal(compareAndSetCalls, 2);
  assert.equal(eventCalls, 1);
  assert.equal(notificationCalls, 2);
});

test("customer may cancel only their own pending delivery", async (t) => {
  setSlackDisabled(t);
  let findUniqueCalls = 0;
  mockTransaction(t, {
    delivery: {
      findUnique: async () => findUniqueCalls++ === 0
        ? delivery({ status: "PENDING" })
        : delivery({ status: "CANCELLED" }),
      updateMany: async () => ({ count: 1 }),
    },
    deliveryEvent: { create: async () => ({}) },
  });
  replaceMethod(t, prisma.notification, "create", async () => ({ id: notificationId }));

  const result = await deliveryService.updateDeliveryStatus(
    deliveryId,
    { id: customerId, role: "CUSTOMER" },
    "CANCELLED",
  );
  assert.equal(result.status, "CANCELLED");
});

test("customer cannot cancel another customer's delivery", async (t) => {
  mockTransaction(t, {
    delivery: {
      findUnique: async () => delivery({ customerId: previousDriverId, status: "PENDING" }),
      updateMany: async () => { throw new Error("must not update"); },
    },
    deliveryEvent: { create: async () => { throw new Error("must not append event"); } },
  });

  await assert.rejects(
    deliveryService.updateDeliveryStatus(
      deliveryId,
      { id: customerId, role: "CUSTOMER" },
      "CANCELLED",
    ),
    { message: "DELIVERY_NOT_FOUND" },
  );
});

test("customer cannot cancel a delivery after driver assignment", async (t) => {
  mockTransaction(t, {
    delivery: {
      findUnique: async () => delivery({ status: "ASSIGNED", driverId }),
      updateMany: async () => { throw new Error("must not update"); },
    },
    deliveryEvent: { create: async () => { throw new Error("must not append event"); } },
  });

  await assert.rejects(
    deliveryService.updateDeliveryStatus(
      deliveryId,
      { id: customerId, role: "CUSTOMER" },
      "CANCELLED",
    ),
    { message: "DELIVERY_FORBIDDEN" },
  );
});

test("driver cannot be deactivated while assigned work is active", async (t) => {
  let updateCalls = 0;
  mockTransaction(t, {
    user: {
        findFirst: async () => ({ id: driverId, status: "ACTIVE", availability: "AVAILABLE" }),
      update: async () => { updateCalls += 1; return { id: driverId, status: "INACTIVE" }; },
    },
    delivery: { count: async () => 2 },
  });

  await assert.rejects(
    driverService.updateDriverStatus(driverId, "INACTIVE"),
    { message: "DRIVER_HAS_ACTIVE_DELIVERIES" },
  );
  assert.equal(updateCalls, 0);
});

test("driver can be deactivated when no active deliveries remain", async (t) => {
  let countArgs: unknown;
  let transactionOptions: { isolationLevel?: string } | undefined;
  const original = (prisma as Record<string, any>).$transaction;
  (prisma as Record<string, any>).$transaction = async (
    callback: (tx: object) => unknown,
    options: typeof transactionOptions,
  ) => {
    transactionOptions = options;
    return callback({
      auditLog: { create: async ({ data }: { data: unknown }) => ({ id: "audit-test-record", ...data as object }) },
      $queryRaw: async () => [],
      user: {
        findFirst: async () => ({ id: driverId, status: "ACTIVE", availability: "AVAILABLE" }),
        update: async () => ({ id: driverId, status: "INACTIVE" }),
      },
      delivery: {
        count: async (args: unknown) => { countArgs = args; return 0; },
      },
    });
  };
  t.after(() => { (prisma as Record<string, any>).$transaction = original; });

  const result = await driverService.updateDriverStatus(driverId, "INACTIVE");

  assert.equal(result.status, "INACTIVE");
  assert.deepEqual(countArgs, {
    where: { driverId, status: { in: ["ASSIGNED", "PICKED_UP", "IN_TRANSIT"] } },
  });
  assert.equal(transactionOptions?.isolationLevel, "Serializable");
});
