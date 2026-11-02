import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
const prefix = `fleetflow.integration.${randomUUID()}`;
const customerEmail = `${prefix}.customer@example.test`;
const secondCustomerEmail = `${prefix}.other-customer@example.test`;
const driverEmail = `${prefix}.driver@example.test`;
const secondDriverEmail = `${prefix}.second-driver@example.test`;
const staffEmail = `${prefix}.staff@example.test`;
const seededUsers: Array<{ id: string; email: string }> = [];
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
    await prisma!.delivery.deleteMany({
      where: { customerId: { in: userIds } },
    });
    await prisma!.user.deleteMany({
      where: { id: { in: userIds }, email: { startsWith: prefix } },
    });
  }
  seededUsers.length = 0;
}

before(async () => {
  if (!runIntegration) return;

  const runtime = await Promise.all([
    import("../src/config/prisma.js"),
    import("../src/modules/deliveries/delivery.service.js"),
    import("../src/modules/notifications/notification.service.js"),
    import("../src/modules/drivers/driver.service.js"),
  ]);
  prisma = runtime[0].prisma;
  deliveryService = runtime[1];
  notificationService = runtime[2];
  driverService = runtime[3];

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
    await prisma!.$disconnect();
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
    { message: "DELIVERY_FORBIDDEN" },
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
