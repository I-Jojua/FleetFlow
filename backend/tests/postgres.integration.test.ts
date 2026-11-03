import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";

const integrationUrl = process.env.FLEETFLOW_TEST_DATABASE_URL;
const runIntegration = process.env.FLEETFLOW_RUN_INTEGRATION === "1";

if (runIntegration && !integrationUrl) {
  throw new Error("FLEETFLOW_TEST_DATABASE_URL is required for integration tests.");
}

if (integrationUrl) {
  const parsedUrl = new URL(integrationUrl);
  if (
    parsedUrl.hostname !== "127.0.0.1" ||
    parsedUrl.port !== "55432" ||
    parsedUrl.username !== "fleetflow_test" ||
    parsedUrl.pathname !== "/fleetflow_test"
  ) {
    throw new Error("Integration tests require the dedicated local fleetflow_test database on port 55432.");
  }

  process.env.DATABASE_URL = integrationUrl;
  process.env.NODE_ENV = "test";
  process.env.JWT_ACCESS_SECRET = "integration_only_access_secret_123456";
  process.env.JWT_REFRESH_SECRET = "integration_only_refresh_secret_123456";
  process.env.SLACK_WEBHOOK_URL = "https://integration.invalid/slack";
}

let prisma: (typeof import("../src/config/prisma.js"))["prisma"] | undefined;
let deliveryService: typeof import("../src/modules/deliveries/delivery.service.js") | undefined;
let notificationService: typeof import("../src/modules/notifications/notification.service.js") | undefined;
let driverService: typeof import("../src/modules/drivers/driver.service.js") | undefined;
let dispatchService: typeof import("../src/modules/dispatch/dispatch.service.js") | undefined;
let workforceService: typeof import("../src/modules/drivers/workforce.service.js") | undefined;
let vehicleService: typeof import("../src/modules/vehicles/vehicle.service.js") | undefined;
const prefix = `fleetflow.integration.${randomUUID()}`;
const customerEmail = `${prefix}.customer@example.test`;
const secondCustomerEmail = `${prefix}.other-customer@example.test`;
const driverEmail = `${prefix}.driver@example.test`;
const secondDriverEmail = `${prefix}.second-driver@example.test`;
const staffEmail = `${prefix}.staff@example.test`;
const seededUsers: Array<{ id: string; email: string }> = [];
const seededVehicleIds: string[] = [];
let fetchMock: typeof fetch | undefined;

async function createUser(
  role: "ADMIN" | "CUSTOMER" | "DRIVER",
  email: string,
) {
  const uniqueEmail = `${email.slice(0, email.lastIndexOf("@"))}.${randomUUID()}@example.test`;
  const user = await prisma!.user.create({
    data: {
      firstName: role,
      lastName: "Integration",
      email: uniqueEmail,
      passwordHash: "integration-test-not-a-real-password-hash",
      role,
      status: "ACTIVE",
    },
  });
  seededUsers.push({ id: user.id, email: uniqueEmail });
  if (role === "DRIVER") {
    const vehicle = await prisma!.vehicle.create({ data: {
      registrationIdentifier: `T-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      type: "VAN", maximumPayloadKg: 5_000, maximumVolumeCubicMeters: 25, refrigerated: true, status: "ACTIVE",
    } });
    seededVehicleIds.push(vehicle.id);
    await prisma!.driverVehicleAssignment.create({ data: { driverId: user.id, vehicleId: vehicle.id } });
    await prisma!.driverShift.create({ data: {
      driverId: user.id, startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 86_400_000),
      timezone: "Etc/UTC", status: "ACTIVE",
    } });
  }
  return user;
}

async function createTestDelivery(customerId: string) {
  return deliveryService!.createDelivery(customerId, {
    recipientName: "Integration Recipient",
    recipientPhone: "+15550000000",
    pickupAddress: "10 Integration Pickup Street",
    deliveryAddress: "20 Integration Delivery Street",
    packageDescription: "Integration test parcel",
  });
}

async function cleanTestData() {
  const userIds = seededUsers.map((user) => user.id);
  if (userIds.length > 0) {
    await prisma!.driverVehicleAssignment.deleteMany({ where: { driverId: { in: userIds } } });
    await prisma!.delivery.deleteMany({
      where: { customerId: { in: userIds } },
    });
    await prisma!.user.deleteMany({
      where: { id: { in: userIds }, email: { startsWith: prefix } },
    });
  }
  if (seededVehicleIds.length > 0) await prisma!.vehicle.deleteMany({ where: { id: { in: seededVehicleIds } } });
  seededUsers.length = 0;
  seededVehicleIds.length = 0;
}

before(async () => {
  if (!runIntegration) return;

  const runtime = await Promise.all([
    import("../src/config/prisma.js"),
    import("../src/modules/deliveries/delivery.service.js"),
    import("../src/modules/notifications/notification.service.js"),
    import("../src/modules/drivers/driver.service.js"),
    import("../src/modules/dispatch/dispatch.service.js"),
    import("../src/modules/drivers/workforce.service.js"),
    import("../src/modules/vehicles/vehicle.service.js"),
  ]);
  prisma = runtime[0].prisma;
  deliveryService = runtime[1];
  notificationService = runtime[2];
  driverService = runtime[3];
  dispatchService = runtime[4];
  workforceService = runtime[5];
  vehicleService = runtime[6];

  const databaseInfo = await prisma!.$queryRaw<Array<{
    current_database: string;
    current_user: string;
  }>>`SELECT current_database(), current_user`;
  assert.deepEqual(databaseInfo, [{
    current_database: "fleetflow_test",
    current_user: "fleetflow_test",
  }]);

  fetchMock = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });
});

after(async () => {
  if (!runIntegration || !prisma) return;
  try {
    await cleanTestData();
  } finally {
    if (fetchMock) globalThis.fetch = fetchMock;
    const { closeRedisConnection } = await import("../src/config/redis.js");
    await Promise.all([prisma!.$disconnect(), closeRedisConnection()]);
  }
});

test("PostgreSQL persists delivery and its creation event; failed event rolls back delivery", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", customerEmail);
  const delivery = await createTestDelivery(customer.id);

  const persisted = await prisma!.delivery.findUniqueOrThrow({
    where: { id: delivery.id },
    include: { events: true },
  });
  assert.equal(persisted.customerId, customer.id);
  assert.equal(persisted.status, "PENDING");
  assert.equal(persisted.events.length, 1);
  assert.equal(persisted.events[0].status, "PENDING");

  const beforeCount = await prisma!.delivery.count({ where: { customerId: customer.id } });
  await assert.rejects(
    deliveryService!.createDelivery(customer.id, {
      recipientName: "Rollback Recipient",
      recipientPhone: "+15550000001",
      pickupAddress: "30 Integration Pickup Street",
      deliveryAddress: "40 Integration Delivery Street",
    }, randomUUID()),
  );
  assert.equal(await prisma!.delivery.count({ where: { customerId: customer.id } }), beforeCount);
});

test("PostgreSQL persists valid delivery status transitions and events", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.transition-customer@example.test`);
  const driver = await createUser("DRIVER", driverEmail);
  const staff = await createUser("ADMIN", staffEmail);
  const delivery = await createTestDelivery(customer.id);

  await deliveryService!.assignDriver(delivery.id, driver.id, staff.id, "ADMIN");
  await deliveryService!.updateDeliveryStatus(delivery.id, { id: driver.id, role: "DRIVER" }, "PICKED_UP");
  await deliveryService!.updateDeliveryStatus(delivery.id, { id: driver.id, role: "DRIVER" }, "IN_TRANSIT");
  const delivered = await deliveryService!.updateDeliveryStatus(
    delivery.id,
    { id: staff.id, role: "ADMIN" },
    "DELIVERED",
  );

  const persisted = await prisma!.delivery.findUniqueOrThrow({
    where: { id: delivery.id },
    include: { events: { orderBy: { createdAt: "asc" } } },
  });
  assert.equal(delivered.status, "DELIVERED");
  assert.equal(persisted.status, "DELIVERED");
  assert.ok(persisted.pickedUpAt);
  assert.ok(persisted.deliveredAt);
  assert.deepEqual(persisted.events.map((event) => event.status).sort(), [
    "ASSIGNED", "DELIVERED", "IN_TRANSIT", "PENDING", "PICKED_UP",
  ]);
});

test("concurrent PostgreSQL status updates allow one winner and persist one transition event", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.race-customer@example.test`);
  const driver = await createUser("DRIVER", `${prefix}.race-driver@example.test`);
  const staff = await createUser("ADMIN", `${prefix}.race-staff@example.test`);
  const delivery = await createTestDelivery(customer.id);
  await deliveryService!.assignDriver(delivery.id, driver.id, staff.id, "ADMIN");

  const results = await Promise.allSettled([
    deliveryService!.updateDeliveryStatus(delivery.id, { id: driver.id, role: "DRIVER" }, "PICKED_UP"),
    deliveryService!.updateDeliveryStatus(delivery.id, { id: driver.id, role: "DRIVER" }, "CANCELLED"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);

  const persisted = await prisma!.delivery.findUniqueOrThrow({
    where: { id: delivery.id },
    include: { events: true },
  });
  assert.ok(["PICKED_UP", "CANCELLED"].includes(persisted.status));
  assert.equal(persisted.events.filter((event) => event.status === persisted.status).length, 1);
});

test("driver assignment and reassignment persist current driver and audit events", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.assignment-customer@example.test`);
  const firstDriver = await createUser("DRIVER", driverEmail);
  const nextDriver = await createUser("DRIVER", secondDriverEmail);
  const staff = await createUser("ADMIN", `${prefix}.assignment-staff@example.test`);
  const delivery = await createTestDelivery(customer.id);

  await deliveryService!.assignDriver(delivery.id, firstDriver.id, staff.id, "ADMIN");
  await deliveryService!.assignDriver(delivery.id, nextDriver.id, staff.id, "ADMIN");

  const persisted = await prisma!.delivery.findUniqueOrThrow({
    where: { id: delivery.id },
    include: { events: { orderBy: { createdAt: "asc" } } },
  });
  assert.equal(persisted.driverId, nextDriver.id);
  assert.equal(persisted.status, "ASSIGNED");
  assert.deepEqual(persisted.events.map((event) => event.status).sort(), [
    "ASSIGNED", "ASSIGNED", "PENDING",
  ]);
});

test("customer ownership and pending cancellation restrictions are enforced by PostgreSQL-backed service", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.owner@example.test`);
  const otherCustomer = await createUser("CUSTOMER", secondCustomerEmail);
  const ownDelivery = await createTestDelivery(customer.id);
  const otherDelivery = await createTestDelivery(otherCustomer.id);

  await assert.rejects(
    deliveryService!.updateDeliveryStatus(otherDelivery.id, { id: customer.id, role: "CUSTOMER" }, "CANCELLED"),
    { message: "DELIVERY_NOT_FOUND" },
  );
  await deliveryService!.updateDeliveryStatus(ownDelivery.id, { id: customer.id, role: "CUSTOMER" }, "CANCELLED");

  const persisted = await prisma!.delivery.findMany({
    where: { id: { in: [ownDelivery.id, otherDelivery.id] } },
    orderBy: { id: "asc" },
    select: { id: true, customerId: true, status: true },
  });
  assert.equal(persisted.length, 2);
  assert.equal(persisted.find((item) => item.id === ownDelivery.id)?.customerId, customer.id);
  assert.equal(persisted.find((item) => item.id === ownDelivery.id)?.status, "CANCELLED");
  assert.equal(persisted.find((item) => item.id === otherDelivery.id)?.status, "PENDING");
});

test("driver with active deliveries cannot be deactivated; inactive driver can", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.deactivation-customer@example.test`);
  const driver = await createUser("DRIVER", `${prefix}.deactivation-driver@example.test`);
  const staff = await createUser("ADMIN", `${prefix}.deactivation-staff@example.test`);
  const delivery = await createTestDelivery(customer.id);
  await deliveryService!.assignDriver(delivery.id, driver.id, staff.id, "ADMIN");

  await assert.rejects(driverService!.updateDriverStatus(driver.id, "INACTIVE"), {
    message: "DRIVER_HAS_ACTIVE_DELIVERIES",
  });
  assert.equal((await prisma!.user.findUniqueOrThrow({ where: { id: driver.id } })).status, "ACTIVE");

  await deliveryService!.updateDeliveryStatus(delivery.id, { id: staff.id, role: "ADMIN" }, "CANCELLED");
  const updated = await driverService!.updateDriverStatus(driver.id, "INACTIVE");
  assert.equal(updated.status, "INACTIVE");
});

test("notifications persist and delivery pagination returns only the requested page", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.pagination-customer@example.test`);
  const first = await createTestDelivery(customer.id);
  const second = await createTestDelivery(customer.id);
  const notifications = await notificationService!.getNotifications(customer.id, 1, 1, false);
  const deliveryPage = await deliveryService!.searchDeliveries({
    search: first.trackingCode,
    page: 1,
    limit: 1,
  });

  const locationCustomer = await createUser("CUSTOMER", `${prefix}.location-customer@example.test`);
  const locationDriver = await createUser("DRIVER", `${prefix}.location-driver@example.test`);
  const staff = await createUser("ADMIN", `${prefix}.location-staff@example.test`);
  const locationDelivery = await createTestDelivery(locationCustomer.id);
  await deliveryService!.assignDriver(locationDelivery.id, locationDriver.id, staff.id, "ADMIN");
  await deliveryService!.updateDeliveryStatus(
    locationDelivery.id,
    { id: locationDriver.id, role: "DRIVER" },
    "PICKED_UP",
  );
  await deliveryService!.updateDriverLocation(locationDelivery.id, locationDriver.id, {
    latitude: 40.7128,
    longitude: -74.006,
  });
  await deliveryService!.updateDriverLocation(locationDelivery.id, locationDriver.id, {
    latitude: 40.7129,
    longitude: -74.0061,
  });
  const locationPage = await deliveryService!.getDriverLocationHistory(locationDelivery.id, 1, 1);

  assert.equal(notifications.notifications.length, 1);
  assert.equal(notifications.pagination.total, 2);
  assert.equal(deliveryPage.deliveries.length, 1);
  assert.equal(deliveryPage.deliveries[0].id, first.id);
  assert.equal(deliveryPage.pagination.total, 1);
  assert.equal(locationPage.locations.length, 1);
  assert.equal(locationPage.pagination.total, 2);

  const persistedNotifications = await prisma!.notification.count({ where: { userId: customer.id } });
  assert.equal(persistedNotifications, 2);
});

test("PostgreSQL enforces tracking-code uniqueness and foreign-key constraints", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.constraint-customer@example.test`);
  const delivery = await createTestDelivery(customer.id);

  await assert.rejects(
    prisma!.delivery.create({
      data: {
        trackingCode: delivery.trackingCode,
        customerId: customer.id,
        recipientName: "Duplicate Tracking",
        recipientPhone: "+15550000002",
        pickupAddress: "50 Integration Pickup Street",
        deliveryAddress: "60 Integration Delivery Street",
      },
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002",
  );

  await assert.rejects(
    prisma!.notification.create({
      data: {
        userId: randomUUID(),
        type: "SYSTEM",
        title: "Invalid foreign key",
        message: "This record must not persist.",
      },
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2003",
  );
});

test("GPS ingestion validates freshness and ownership, serializes concurrent timestamps, and filters history", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.gps-customer@example.test`);
  const driver = await createUser("DRIVER", `${prefix}.gps-driver@example.test`);
  const otherDriver = await createUser("DRIVER", `${prefix}.gps-other-driver@example.test`);
  const staff = await createUser("ADMIN", `${prefix}.gps-staff@example.test`);
  const delivery = await createTestDelivery(customer.id);
  await deliveryService!.assignDriver(delivery.id, driver.id, staff.id, "ADMIN");
  await deliveryService!.updateDeliveryStatus(delivery.id, { id: driver.id, role: "DRIVER" }, "PICKED_UP");

  const firstTimestamp = new Date(Date.now() - 10_000);
  const first = await deliveryService!.updateDriverLocation(delivery.id, driver.id, {
    latitude: 40.7128,
    longitude: -74.006,
    accuracy: 18,
    timestamp: firstTimestamp.toISOString(),
  });
  assert.equal(first.recordedAt.toISOString(), firstTimestamp.toISOString());

  await assert.rejects(
    deliveryService!.updateDriverLocation(delivery.id, otherDriver.id, { latitude: 40, longitude: 40 }),
    /DELIVERY_NOT_FOUND/,
  );
  await assert.rejects(
    deliveryService!.updateDriverLocation(delivery.id, driver.id, { latitude: 90.1, longitude: 0 }),
    /LOCATION_INVALID/,
  );
  await assert.rejects(
    deliveryService!.updateDriverLocation(delivery.id, driver.id, {
      latitude: 40, longitude: 40, timestamp: new Date(Date.now() - 600_000).toISOString(),
    }),
    /LOCATION_STALE/,
  );
  await assert.rejects(
    deliveryService!.updateDriverLocation(delivery.id, driver.id, {
      latitude: 40, longitude: 40, timestamp: new Date(Date.now() + 600_000).toISOString(),
    }),
    /LOCATION_TIMESTAMP_IN_FUTURE/,
  );
  await assert.rejects(
    deliveryService!.updateDriverLocation(delivery.id, driver.id, {
      latitude: 40, longitude: 40, timestamp: new Date(firstTimestamp.getTime() - 1_000).toISOString(),
    }),
    /LOCATION_OUT_OF_ORDER/,
  );

  const secondDelivery = await createTestDelivery(customer.id);
  await deliveryService!.assignDriver(secondDelivery.id, driver.id, staff.id, "ADMIN");
  await deliveryService!.updateDeliveryStatus(secondDelivery.id, { id: driver.id, role: "DRIVER" }, "PICKED_UP");
  await assert.rejects(
    deliveryService!.updateDriverLocation(secondDelivery.id, driver.id, {
      latitude: 40, longitude: 40, timestamp: new Date(firstTimestamp.getTime() - 500).toISOString(),
    }),
    /LOCATION_OUT_OF_ORDER/,
  );

  const concurrentTimestamp = new Date(Date.now() - 5_000).toISOString();
  const concurrent = await Promise.allSettled([
    deliveryService!.updateDriverLocation(delivery.id, driver.id, {
      latitude: 40.713, longitude: -74.007, timestamp: concurrentTimestamp,
    }),
    deliveryService!.updateDriverLocation(delivery.id, driver.id, {
      latitude: 40.714, longitude: -74.008, timestamp: concurrentTimestamp,
    }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);

  const page = await deliveryService!.getDriverLocationHistory(delivery.id, 1, 10, {
    from: firstTimestamp,
    to: new Date(Date.now() + 1_000),
  });
  assert.equal(page.locations.length, 2);
  assert.equal(page.pagination.total, 2);

  const active = await driverService!.getActiveDriverLocations(1, 10);
  assert.equal(active.locations.some((location) => location.driverId === driver.id && location.deliveryId === delivery.id), true);

  const batchStartedAt = performance.now();
  const gpsBatch = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    deliveryService!.updateDriverLocation(delivery.id, driver.id, {
      latitude: 40.72 + index / 10_000,
      longitude: -74.01 - index / 10_000,
    }),
  ));
  const batchDurationMs = performance.now() - batchStartedAt;
  assert.equal(gpsBatch.length, 20);
  assert.equal(await prisma!.driverLocation.count({ where: { deliveryId: delivery.id } }), 22);
  console.log(`P5.2_GPS_BATCH updates=20 persisted=20 durationMs=${batchDurationMs.toFixed(1)} avgMs=${(batchDurationMs / 20).toFixed(1)} database=isolated-postgres redis=isolated-redis`);
});

test("dispatch recommendations use current eligible drivers, stable ranking, bounded results, and persist audit events", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.dispatch-customer@example.test`);
  const staff = await createUser("ADMIN", `${prefix}.dispatch-staff@example.test`);
  const nearDriver = await createUser("DRIVER", `${prefix}.dispatch-near@example.test`);
  const farDriver = await createUser("DRIVER", `${prefix}.dispatch-far@example.test`);
  const tieDriverA = await createUser("DRIVER", `${prefix}.dispatch-tie-a@example.test`);
  const tieDriverB = await createUser("DRIVER", `${prefix}.dispatch-tie-b@example.test`);
  const staleDriver = await createUser("DRIVER", `${prefix}.dispatch-stale@example.test`);
  const suspendedDriver = await createUser("DRIVER", `${prefix}.dispatch-suspended@example.test`);
  const overloadedDriver = await createUser("DRIVER", `${prefix}.dispatch-overloaded@example.test`);
  await prisma!.user.update({ where: { id: suspendedDriver.id }, data: { status: "SUSPENDED" } });
  const delivery = await deliveryService!.createDelivery(customer.id, {
    recipientName: "Dispatch Recipient",
    recipientPhone: "+15550000010",
    pickupAddress: "10 Dispatch Pickup Street",
    pickupLatitude: 41.7151,
    pickupLongitude: 44.8271,
    deliveryAddress: "20 Dispatch Delivery Street",
  });
  const tiedLocationTime = new Date(Date.now() - 10_000);
  await prisma!.driverLocation.createMany({ data: [
    { driverId: nearDriver.id, latitude: 41.7152, longitude: 44.8272 },
    { driverId: farDriver.id, latitude: 42.0, longitude: 45.0 },
    { driverId: tieDriverA.id, latitude: 41.8, longitude: 44.9, recordedAt: tiedLocationTime },
    { driverId: tieDriverB.id, latitude: 41.8, longitude: 44.9, recordedAt: tiedLocationTime },
    { driverId: staleDriver.id, latitude: 41.7151, longitude: 44.8271, recordedAt: new Date(Date.now() - 600_000) },
    { driverId: suspendedDriver.id, latitude: 41.7151, longitude: 44.8271 },
    { driverId: overloadedDriver.id, latitude: 41.7151, longitude: 44.8271 },
  ] });
  const { env } = await import("../src/config/env.js");
  for (let index = 0; index < env.DISPATCH_MAX_ACTIVE_DELIVERIES; index += 1) {
    const active = await createTestDelivery(customer.id);
    await prisma!.delivery.update({ where: { id: active.id }, data: { driverId: overloadedDriver.id, status: "ASSIGNED" } });
  }

  const result = await dispatchService!.recommendDrivers(delivery.id, { id: staff.id, role: "ADMIN" }, 10);
  const resultDriverIds = result.candidates.map((candidate) => candidate.driverId);
  assert.equal(resultDriverIds.includes(nearDriver.id), true);
  assert.equal(resultDriverIds.includes(farDriver.id), true);
  assert.equal(resultDriverIds.includes(staleDriver.id), false);
  assert.equal(resultDriverIds.includes(suspendedDriver.id), false);
  assert.equal(resultDriverIds.includes(overloadedDriver.id), false);
  assert.ok(resultDriverIds.indexOf(nearDriver.id) < resultDriverIds.indexOf(farDriver.id));
  assert.equal(
    resultDriverIds.indexOf(tieDriverA.id) < resultDriverIds.indexOf(tieDriverB.id),
    tieDriverA.id.localeCompare(tieDriverB.id) < 0,
  );
  assert.deepEqual(result.candidates.map((candidate) => candidate.rankingPosition), result.candidates.map((_, index) => index + 1));
  assert.equal(result.candidates.find((candidate) => candidate.driverId === nearDriver.id)?.distanceEstimate.method, "STRAIGHT_LINE_APPROXIMATION");
  assert.equal(result.advisoryOnly, true);
  assert.equal(await prisma!.auditLog.count({ where: { actorUserId: staff.id, action: "dispatch.recommendations", resourceId: delivery.id } }), 1);

  await assert.rejects(
    dispatchService!.recommendDrivers(randomUUID(), { id: staff.id, role: "ADMIN" }, 10),
    /DELIVERY_NOT_FOUND/,
  );
  await assert.rejects(
    dispatchService!.recommendDrivers((await createTestDelivery(customer.id)).id, { id: staff.id, role: "ADMIN" }, 10),
    /DRIVER_LOCATION_REQUIRED_FOR_DISPATCH/,
  );
});

test("assignment revalidates fresh pickup GPS and workload inside the assignment transaction", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.dispatch-assign-customer@example.test`);
  const driver = await createUser("DRIVER", `${prefix}.dispatch-assign-driver@example.test`);
  const staff = await createUser("ADMIN", `${prefix}.dispatch-assign-staff@example.test`);
  const delivery = await deliveryService!.createDelivery(customer.id, {
    recipientName: "Assignment Recipient",
    recipientPhone: "+15550000011",
    pickupAddress: "10 Assignment Pickup Street",
    pickupLatitude: 41.7151,
    pickupLongitude: 44.8271,
    deliveryAddress: "20 Assignment Delivery Street",
  });
  await assert.rejects(deliveryService!.assignDriver(delivery.id, driver.id, staff.id, "ADMIN"), /DRIVER_GPS_STALE_FOR_DISPATCH/);
  await prisma!.driverLocation.create({ data: { driverId: driver.id, latitude: 41.7151, longitude: 44.8271 } });
  const assigned = await deliveryService!.assignDriver(delivery.id, driver.id, staff.id, "ADMIN");
  assert.equal(assigned.driverId, driver.id);
});

test("workforce eligibility filters unavailable drivers and assignment revalidates vehicle, shift, qualification, and persists vehicle", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.workforce-customer@example.test`);
  const driver = await createUser("DRIVER", `${prefix}.workforce-driver@example.test`);
  const staff = await createUser("ADMIN", `${prefix}.workforce-staff@example.test`);
  const vehicleAssignment = await prisma!.driverVehicleAssignment.findFirstOrThrow({ where: { driverId: driver.id, endedAt: null } });
  const delivery = await deliveryService!.createDelivery(customer.id, {
    recipientName: "Workforce Recipient", recipientPhone: "+15550000014",
    pickupAddress: "10 Workforce Pickup Street", pickupLatitude: 41.7151, pickupLongitude: 44.8271,
    deliveryAddress: "20 Workforce Delivery Street", requiredVehicleType: "VAN", minimumPayloadKg: 500,
    minimumVolumeCubicMeters: 5, requiresRefrigeratedTransport: true, requiredQualifications: ["REFRIGERATED"],
  });
  const qualification = await workforceService!.createQualification(driver.id, {
    qualificationType: "REFRIGERATED", expiresAt: new Date(Date.now() + 86_400_000),
  }, { userId: staff.id, role: "ADMIN" });
  await prisma!.driverLocation.create({ data: { driverId: driver.id, latitude: 41.7151, longitude: 44.8271 } });

  const pendingQualification = await dispatchService!.recommendDrivers(delivery.id, { id: staff.id, role: "ADMIN" }, 10);
  assert.equal(pendingQualification.candidates.some((candidate) => candidate.driverId === driver.id), false);
  await workforceService!.verifyQualification(driver.id, qualification.id, "VERIFIED", { userId: staff.id, role: "ADMIN" });
  const recommended = await dispatchService!.recommendDrivers(delivery.id, { id: staff.id, role: "ADMIN" }, 10);
  assert.equal(recommended.candidates.some((candidate) => candidate.driverId === driver.id), true);

  const expiredRequirement = await deliveryService!.createDelivery(customer.id, {
    recipientName: "Expired Qualification", recipientPhone: "+15550000015",
    pickupAddress: "10 Expired Pickup Street", pickupLatitude: 41.7151, pickupLongitude: 44.8271,
    deliveryAddress: "20 Expired Delivery Street", requiredQualifications: ["EXPIRED_CODE"],
  });
  await prisma!.driverQualification.create({ data: {
    driverId: driver.id, qualificationType: "EXPIRED_CODE", verificationStatus: "VERIFIED", verifiedById: staff.id,
    expiresAt: new Date(Date.now() - 60_000),
  } });
  const expiredCandidate = await dispatchService!.recommendDrivers(expiredRequirement.id, { id: staff.id, role: "ADMIN" }, 10);
  assert.equal(expiredCandidate.candidates.some((candidate) => candidate.driverId === driver.id), false);

  await workforceService!.updateDriverAvailability(driver.id, "OFF_DUTY", { userId: staff.id, role: "ADMIN" });
  const unavailable = await dispatchService!.recommendDrivers(delivery.id, { id: staff.id, role: "ADMIN" }, 10);
  assert.equal(unavailable.candidates.some((candidate) => candidate.driverId === driver.id), false);
  await assert.rejects(deliveryService!.assignDriver(delivery.id, driver.id, staff.id, "ADMIN"), /DRIVER_UNAVAILABLE/);

  await workforceService!.updateDriverAvailability(driver.id, "AVAILABLE", { userId: staff.id, role: "ADMIN" });
  const assigned = await deliveryService!.assignDriver(delivery.id, driver.id, staff.id, "ADMIN");
  assert.equal(assigned.driverId, driver.id);
  assert.equal((await prisma!.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).vehicleId, vehicleAssignment.vehicleId);

  await assert.rejects(workforceService!.createDriverShift(driver.id, {
    startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 60_000), timezone: "Etc/UTC",
  }, { userId: staff.id, role: "ADMIN" }), /DRIVER_SHIFT_OVERLAP/);
});

test("vehicle management rejects duplicate registrations, maintenance assignments, and capability changes during active work", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.vehicle-customer@example.test`);
  const driver = await createUser("DRIVER", `${prefix}.vehicle-driver@example.test`);
  const staff = await createUser("ADMIN", `${prefix}.vehicle-staff@example.test`);
  const vehicleData = {
    registrationIdentifier: `V-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    type: "VAN" as const,
    maximumPayloadKg: 4_000,
    maximumVolumeCubicMeters: 20,
    refrigerated: true,
  };
  const spareVehicle = await vehicleService!.createVehicle(vehicleData, { userId: staff.id, role: "ADMIN" });
  seededVehicleIds.push(spareVehicle.id);
  await assert.rejects(
    vehicleService!.createVehicle(vehicleData, { userId: staff.id, role: "ADMIN" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "P2002",
  );
  await vehicleService!.updateVehicleStatus(spareVehicle.id, "MAINTENANCE", { userId: staff.id, role: "ADMIN" });
  await assert.rejects(
    vehicleService!.assignVehicleToDriver(spareVehicle.id, driver.id, { userId: staff.id, role: "ADMIN" }),
    /VEHICLE_NOT_ACTIVE/,
  );
  await vehicleService!.updateVehicleStatus(spareVehicle.id, "ACTIVE", { userId: staff.id, role: "ADMIN" });
  await vehicleService!.assignVehicleToDriver(spareVehicle.id, driver.id, { userId: staff.id, role: "ADMIN" });
  const secondDriver = await createUser("DRIVER", `${prefix}.vehicle-second-driver@example.test`);
  await assert.rejects(
    vehicleService!.assignVehicleToDriver(spareVehicle.id, secondDriver.id, { userId: staff.id, role: "ADMIN" }),
    /VEHICLE_ALREADY_ASSIGNED/,
  );
  const driverAssignments = await prisma!.driverVehicleAssignment.findMany({ where: { driverId: driver.id } });
  assert.equal(driverAssignments.length, 2);
  assert.equal(driverAssignments.filter((assignment) => assignment.endedAt === null).length, 1);
  const activeAssignment = driverAssignments.find((assignment) => assignment.endedAt === null)!;

  const activeDelivery = await createTestDelivery(customer.id);
  await prisma!.delivery.update({
    where: { id: activeDelivery.id },
    data: { driverId: driver.id, vehicleId: activeAssignment.vehicleId, status: "IN_TRANSIT" },
  });
  const actor = { userId: staff.id, role: "ADMIN" as const };
  await assert.rejects(vehicleService!.updateVehicle(activeAssignment.vehicleId, { type: "TRUCK" }, actor), /VEHICLE_HAS_ACTIVE_DELIVERIES/);
  await assert.rejects(vehicleService!.updateVehicle(activeAssignment.vehicleId, { refrigerated: false }, actor), /VEHICLE_HAS_ACTIVE_DELIVERIES/);
  await assert.rejects(vehicleService!.updateVehicle(activeAssignment.vehicleId, { maximumVolumeCubicMeters: null }, actor), /VEHICLE_HAS_ACTIVE_DELIVERIES/);
  await assert.rejects(vehicleService!.updateVehicle(activeAssignment.vehicleId, { maximumPayloadKg: 1_000 }, actor), /VEHICLE_HAS_ACTIVE_DELIVERIES/);
  assert.equal(await prisma!.auditLog.count({ where: { actorUserId: staff.id, action: "vehicles.create", resourceId: spareVehicle.id } }), 1);
});

test("concurrent workforce shift creation permits only one overlapping schedule and audits availability", {
  skip: !runIntegration,
}, async () => {
  const driver = await createUser("DRIVER", `${prefix}.shift-race-driver@example.test`);
  const staff = await createUser("ADMIN", `${prefix}.shift-race-staff@example.test`);
  const actor = { userId: staff.id, role: "ADMIN" as const };
  const startsAt = new Date(Date.now() + 2 * 86_400_000);
  const outcomes = await Promise.allSettled([
    workforceService!.createDriverShift(driver.id, { startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), timezone: "Asia/Tbilisi" }, actor),
    workforceService!.createDriverShift(driver.id, { startsAt: new Date(startsAt.getTime() + 30 * 60_000), endsAt: new Date(startsAt.getTime() + 90 * 60_000), timezone: "Etc/UTC" }, actor),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);

  await workforceService!.updateDriverAvailability(driver.id, "ON_BREAK", actor);
  await workforceService!.updateDriverAvailability(driver.id, "SUSPENDED", actor);
  await assert.rejects(workforceService!.updateDriverAvailability(driver.id, "AVAILABLE", actor), /INVALID_AVAILABILITY_TRANSITION/);
  assert.equal(await prisma!.auditLog.count({ where: { actorUserId: staff.id, action: "drivers.availability_update", resourceId: driver.id } }), 2);
  await prisma!.user.update({ where: { id: driver.id }, data: { status: "SUSPENDED" } });
  await assert.rejects(workforceService!.updateDriverAvailability(driver.id, "AVAILABLE", actor), /INACTIVE_DRIVER_CANNOT_BE_AVAILABLE/);
});

test("concurrent assignment revalidation keeps a driver's active workload within the configured limit", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER", `${prefix}.dispatch-race-customer@example.test`);
  const driver = await createUser("DRIVER", `${prefix}.dispatch-race-driver@example.test`);
  const staff = await createUser("ADMIN", `${prefix}.dispatch-race-staff@example.test`);
  const { env } = await import("../src/config/env.js");
  await prisma!.driverLocation.create({ data: { driverId: driver.id, latitude: 41.7151, longitude: 44.8271 } });
  for (let index = 0; index < env.DISPATCH_MAX_ACTIVE_DELIVERIES - 1; index += 1) {
    const active = await createTestDelivery(customer.id);
    await prisma!.delivery.update({ where: { id: active.id }, data: { driverId: driver.id, status: "ASSIGNED" } });
  }
  const createCoordinateDelivery = (phone: string) => deliveryService!.createDelivery(customer.id, {
    recipientName: "Concurrent Assignment",
    recipientPhone: phone,
    pickupAddress: "10 Concurrent Pickup Street",
    pickupLatitude: 41.7151,
    pickupLongitude: 44.8271,
    deliveryAddress: "20 Concurrent Delivery Street",
  });
  const targets = await Promise.all([createCoordinateDelivery("+15550000012"), createCoordinateDelivery("+15550000013")]);
  const outcomes = await Promise.allSettled(targets.map((target) => deliveryService!.assignDriver(target.id, driver.id, staff.id, "ADMIN")));
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(await prisma!.delivery.count({ where: { driverId: driver.id, status: { in: ["ASSIGNED", "PICKED_UP", "IN_TRANSIT"] } } }), env.DISPATCH_MAX_ACTIVE_DELIVERIES);
});
