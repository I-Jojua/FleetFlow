import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import type { Express } from "express";
import type { UserRole } from "../src/generated/prisma/client.js";

const integrationUrl = process.env.FLEETFLOW_TEST_DATABASE_URL;
const runIntegration = process.env.FLEETFLOW_RUN_INTEGRATION === "1";
if (runIntegration && !integrationUrl) {
  throw new Error("FLEETFLOW_TEST_DATABASE_URL is required for authorization integration tests.");
}
if (integrationUrl) {
  const target = new URL(integrationUrl);
  if (target.hostname !== "127.0.0.1" || target.port !== "55432" || target.username !== "fleetflow_test" || target.pathname !== "/fleetflow_test") {
    throw new Error("Authorization integration tests require the isolated fleetflow_test database on port 55432.");
  }
}

const prefix = `authorization-integration-${randomUUID()}`;
const userIds: string[] = [];
const deliveryIds: string[] = [];
let prisma: (typeof import("../src/config/prisma.js"))["prisma"] | undefined;
let accessSecret: string;

async function createUser(role: UserRole, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const user = await prisma!.user.create({
    data: {
      firstName: "Authorization",
      lastName: role,
      email: `${prefix}-${randomUUID()}@example.test`,
      passwordHash: "integration-only-placeholder",
      role,
      status,
    },
  });
  userIds.push(user.id);
  return user;
}

function authHeader(userId: string, tokenRole: UserRole = "CUSTOMER") {
  return `Bearer ${jwt.sign({ sub: userId, role: tokenRole }, accessSecret)}`;
}

async function withApiServer<T>(callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const appModule = await import("../src/app.js");
  const server = createServer(appModule.default as unknown as Express);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind authorization test server.");
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function createDelivery(customerId: string, driverId?: string) {
  const delivery = await prisma!.delivery.create({
    data: {
      customerId,
      driverId,
      trackingCode: `FF-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
      recipientName: "Authorization Recipient",
      recipientPhone: "+15550000000",
      pickupAddress: "10 Authorization Pickup Street",
      deliveryAddress: "20 Authorization Delivery Street",
      ...(driverId ? { status: "PICKED_UP" as const } : {}),
    },
  });
  deliveryIds.push(delivery.id);
  if (driverId) {
    await prisma!.driverLocation.create({
      data: { driverId, deliveryId: delivery.id, latitude: 41.7151, longitude: 44.8271 },
    });
  }
  return delivery;
}

before(async () => {
  if (!runIntegration) return;
  const [prismaModule, envModule] = await Promise.all([
    import("../src/config/prisma.js"),
    import("../src/config/env.js"),
  ]);
  prisma = prismaModule.prisma;
  accessSecret = envModule.env.JWT_ACCESS_SECRET;
  const databaseInfo = await prisma.$queryRaw<Array<{ current_database: string; current_user: string }>>`SELECT current_database(), current_user`;
  assert.deepEqual(databaseInfo, [{ current_database: "fleetflow_test", current_user: "fleetflow_test" }]);
});

after(async () => {
  if (!runIntegration || !prisma) return;
  try {
    if (deliveryIds.length) await prisma.delivery.deleteMany({ where: { id: { in: deliveryIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    const [{ closeRedisConnection }, { closeQueueRegistry }] = await Promise.all([
      import("../src/config/redis.js"),
      import("../src/jobs/queue-registry.js"),
    ]);
    await Promise.all([prisma.$disconnect(), closeRedisConnection(), closeQueueRegistry()]);
  }
});

test("API authorization uses active database roles and rejects missing, invalid, suspended, and spoofed roles", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER");
  const suspended = await createUser("CUSTOMER", "SUSPENDED");
  const admin = await createUser("ADMIN");

  await withApiServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/v1/drivers`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/v1/drivers`, { headers: { authorization: "Bearer invalid-token" } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/v1/drivers`, { headers: { authorization: authHeader(suspended.id, "ADMIN") } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/v1/drivers`, { headers: { authorization: authHeader(customer.id, "ADMIN") } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/v1/drivers`, { headers: { authorization: authHeader(admin.id, "CUSTOMER") } })).status, 200);

    const ownedByAnother = await createUser("CUSTOMER");
    const before = await prisma!.delivery.count({ where: { customerId: ownedByAnother.id } });
    const forgedCreation = await fetch(`${baseUrl}/api/v1/deliveries`, {
      method: "POST",
      headers: { authorization: authHeader(customer.id), "content-type": "application/json" },
      body: JSON.stringify({
        customerId: ownedByAnother.id,
        recipientName: "Authorization Recipient",
        recipientPhone: "+15550000000",
        pickupAddress: "10 Authorization Pickup Street",
        deliveryAddress: "20 Authorization Delivery Street",
      }),
    });
    assert.equal(forgedCreation.status, 403);
    assert.equal(await prisma!.delivery.count({ where: { customerId: ownedByAnother.id } }), before);
  });
});

test("delivery details and nested GPS reads are owner-scoped and hide other users' resources", {
  skip: !runIntegration,
}, async () => {
  const owner = await createUser("CUSTOMER");
  const otherCustomer = await createUser("CUSTOMER");
  const assignedDriver = await createUser("DRIVER");
  const otherDriver = await createUser("DRIVER");
  const staff = await createUser("DISPATCHER");
  const delivery = await createDelivery(owner.id, assignedDriver.id);
  const notification = await prisma!.notification.create({
    data: {
      userId: owner.id,
      deliveryId: delivery.id,
      type: "DELIVERY_UPDATE",
      title: "Authorization test",
      message: "Private notification fixture",
    },
  });

  await withApiServer(async (baseUrl) => {
    const paths = [
      `/api/v1/deliveries/${delivery.id}`,
      `/api/v1/deliveries/${delivery.id}/location`,
      `/api/v1/deliveries/${delivery.id}/location/history`,
    ];
    for (const path of paths) {
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: authHeader(owner.id) } })).status, 200);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: authHeader(otherCustomer.id) } })).status, 404);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: authHeader(otherDriver.id, "DRIVER") } })).status, 404);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: authHeader(assignedDriver.id, "DRIVER") } })).status, 200);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: authHeader(staff.id, "DISPATCHER") } })).status, 200);
    }
    assert.equal((await fetch(`${baseUrl}/api/v1/deliveries/${delivery.id}/status`, {
      method: "PATCH",
      headers: { authorization: authHeader(otherCustomer.id), "content-type": "application/json" },
      body: JSON.stringify({ status: "CANCELLED" }),
    })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/v1/deliveries/${delivery.id}/status`, {
      method: "PATCH",
      headers: { authorization: authHeader(otherDriver.id, "DRIVER"), "content-type": "application/json" },
      body: JSON.stringify({ status: "IN_TRANSIT" }),
    })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/v1/deliveries/${delivery.id}/location`, {
      method: "PATCH",
      headers: { authorization: authHeader(otherDriver.id, "DRIVER"), "content-type": "application/json" },
      body: JSON.stringify({ latitude: 41.7, longitude: 44.8 }),
    })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/v1/notifications/${notification.id}/read`, {
      method: "PATCH",
      headers: { authorization: authHeader(otherCustomer.id) },
    })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/v1/notifications/${notification.id}/read`, {
      method: "PATCH",
      headers: { authorization: authHeader(owner.id) },
    })).status, 200);
  });
});
