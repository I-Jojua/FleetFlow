import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Express } from "express";
import jwt from "jsonwebtoken";
import { WebSocket } from "ws";
import type { UserRole } from "../src/generated/prisma/client.js";
type RealtimeGateway = { start: () => Promise<void>; close: () => Promise<void> };

const integrationUrl = process.env.FLEETFLOW_TEST_DATABASE_URL;
const integrationRedisUrl = process.env.FLEETFLOW_TEST_REDIS_URL;
const runIntegration = process.env.FLEETFLOW_RUN_INTEGRATION === "1";
if (runIntegration && (!integrationUrl || !integrationRedisUrl)) {
  throw new Error("Isolated PostgreSQL and Redis URLs are required for realtime integration tests.");
}
if (integrationUrl) {
  const target = new URL(integrationUrl);
  if (target.hostname !== "127.0.0.1" || target.port !== "55432" || target.username !== "fleetflow_test" || target.pathname !== "/fleetflow_test") {
    throw new Error("Realtime integration tests require the isolated fleetflow_test database on port 55432.");
  }
}
if (integrationRedisUrl) {
  const target = new URL(integrationRedisUrl);
  if (target.hostname !== "127.0.0.1" || target.port !== "56379") {
    throw new Error("Realtime integration tests require the isolated Redis service on port 56379.");
  }
}

const prefix = `realtime-integration-${randomUUID()}`;
const userIds: string[] = [];
const vehicleIds: string[] = [];
const deliveryIds: string[] = [];
let prisma: (typeof import("../src/config/prisma.js"))["prisma"] | undefined;
let redis: (typeof import("../src/config/redis.js"))["redis"] | undefined;
let metrics: (typeof import("../src/observability/metrics.js"))["metrics"] | undefined;
let env: (typeof import("../src/config/env.js"))["env"];
let fetchOriginal: typeof fetch | undefined;
let serverOne: ReturnType<typeof createServer> | undefined;
let serverTwo: ReturnType<typeof createServer> | undefined;
let gatewayOne: RealtimeGateway | undefined;
let gatewayTwo: RealtimeGateway | undefined;
let baseOne: string;
let baseTwo: string;

async function createUser(role: UserRole) {
  const user = await prisma!.user.create({
    data: {
      firstName: "Realtime",
      lastName: role,
      email: `${prefix}-${randomUUID()}@example.test`,
      passwordHash: "integration-only-placeholder",
      role,
      status: "ACTIVE",
    },
  });
  userIds.push(user.id);
  if (role === "DRIVER") {
    const vehicle = await prisma!.vehicle.create({ data: { registrationIdentifier: `R-${randomUUID().replaceAll("-", "").slice(0, 20)}`, type: "VAN", maximumPayloadKg: 5_000, maximumVolumeCubicMeters: 25, refrigerated: true } });
    vehicleIds.push(vehicle.id);
    await prisma!.driverVehicleAssignment.create({ data: { driverId: user.id, vehicleId: vehicle.id } });
    await prisma!.driverShift.create({ data: { driverId: user.id, startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 86_400_000), timezone: "Etc/UTC", status: "ACTIVE" } });
  }
  return user;
}

function authHeader(userId: string, role: UserRole) {
  return `Bearer ${jwt.sign({ sub: userId, role }, env.JWT_ACCESS_SECRET)}`;
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind realtime integration server.");
  return `http://127.0.0.1:${address.port}`;
}

interface SocketClient {
  socket: WebSocket;
  waitFor: (predicate: (message: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
}

async function connectSocket(url: string): Promise<SocketClient> {
  const socket = new WebSocket(url);
  const backlog: Record<string, unknown>[] = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  socket.on("message", (data) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      backlog.push(message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => reject(new Error(`WebSocket handshake returned ${response.statusCode}.`)));
  });

  return {
    socket,
    waitFor(predicate) {
      const existing = backlog.findIndex(predicate);
      if (existing >= 0) return Promise.resolve(backlog.splice(existing, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for a realtime event."));
        }, 3_000);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

async function expectHandshakeStatus(url: string, status: number) {
  const socket = new WebSocket(url);
  const actual = await new Promise<number>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("open", () => reject(new Error("Expected WebSocket handshake to fail.")));
    socket.once("error", (error) => {
      if (socket.readyState !== WebSocket.CONNECTING) reject(error);
    });
  });
  assert.equal(actual, status);
  socket.terminate();
}

async function closeSocket(socket?: WebSocket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { socket.terminate(); resolve(); }, 1_000);
    socket.once("close", () => { clearTimeout(timeout); resolve(); });
    socket.close(1000, "test complete");
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for realtime state to change.");
}

async function requestTicket(userId: string, role: UserRole) {
  const response = await fetch(`${baseOne}/api/v1/realtime/ticket`, {
    method: "POST",
    headers: { authorization: authHeader(userId, role) },
  });
  assert.equal(response.status, 201);
  return (await response.json() as { data: { ticket: string } }).data.ticket;
}

before(async () => {
  if (!runIntegration) return;
  const [prismaModule, redisModule, metricsModule, envModule, appModule, gatewayModule] = await Promise.all([
    import("../src/config/prisma.js"),
    import("../src/config/redis.js"),
    import("../src/observability/metrics.js"),
    import("../src/config/env.js"),
    import("../src/app.js"),
    import("../src/modules/realtime/realtime.gateway.js"),
  ]);
  prisma = prismaModule.prisma;
  redis = redisModule.redis;
  metrics = metricsModule.metrics;
  env = envModule.env;
  const databaseInfo = await prisma.$queryRaw<Array<{ current_database: string; current_user: string }>>`SELECT current_database(), current_user`;
  assert.deepEqual(databaseInfo, [{ current_database: "fleetflow_test", current_user: "fleetflow_test" }]);

  fetchOriginal = globalThis.fetch;
  const slackWebhookUrl = env.SLACK_WEBHOOK_URL;
  globalThis.fetch = async (input, init) => {
    if (slackWebhookUrl && String(input) === slackWebhookUrl) return new Response("ok", { status: 200 });
    return fetchOriginal!(input, init);
  };

  serverOne = createServer(appModule.default as unknown as Express);
  gatewayOne = gatewayModule.createRealtimeGateway(serverOne);
  await gatewayOne.start();
  baseOne = await listen(serverOne);

  serverTwo = createServer(appModule.default as unknown as Express);
  gatewayTwo = gatewayModule.createRealtimeGateway(serverTwo);
  await gatewayTwo.start();
  baseTwo = await listen(serverTwo);
  await new Promise((resolve) => setTimeout(resolve, 100));
});

after(async () => {
  if (!runIntegration || !prisma) return;
  try {
    if (deliveryIds.length) await prisma.delivery.deleteMany({ where: { id: { in: deliveryIds } } });
    if (userIds.length) {
      await prisma.driverVehicleAssignment.deleteMany({ where: { driverId: { in: userIds } } });
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (vehicleIds.length) await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
  } finally {
    await Promise.allSettled([gatewayOne?.close(), gatewayTwo?.close()]);
    await Promise.all([serverOne, serverTwo].filter((server): server is NonNullable<typeof server> => Boolean(server)).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    if (fetchOriginal) globalThis.fetch = fetchOriginal;
    const [{ closeRedisConnection }, { closeQueueRegistry }] = await Promise.all([
      import("../src/config/redis.js"),
      import("../src/jobs/queue-registry.js"),
    ]);
    await Promise.all([prisma.$disconnect(), closeRedisConnection(), closeQueueRegistry()]);
  }
});

test("WebSocket uses one-use authenticated tickets, role-checked subscriptions, Redis fanout, and fresh tickets after reconnect", {
  skip: !runIntegration,
}, async () => {
  const customer = await createUser("CUSTOMER");
  const otherCustomer = await createUser("CUSTOMER");
  const driver = await createUser("DRIVER");
  const dispatcher = await createUser("DISPATCHER");
  const otherDriver = await createUser("DRIVER");
  const deliveryService = await import("../src/modules/deliveries/delivery.service.js");
  const delivery = await deliveryService.createDelivery(customer.id, {
    recipientName: "Realtime Recipient",
    recipientPhone: "+15550000000",
    pickupAddress: "10 Realtime Pickup Street",
    deliveryAddress: "20 Realtime Delivery Street",
  }, customer.id, "CUSTOMER");
  deliveryIds.push(delivery.id);
  await deliveryService.assignDriver(delivery.id, driver.id, dispatcher.id, "DISPATCHER");
  await deliveryService.updateDeliveryStatus(delivery.id, { id: driver.id, role: "DRIVER" }, "PICKED_UP");

  await expectHandshakeStatus(`${baseTwo}/api/v1/realtime/socket`, 401);
  const firstTicket = await requestTicket(customer.id, "CUSTOMER");
  const ownerSocket = await connectSocket(`${baseTwo}/api/v1/realtime/socket?ticket=${encodeURIComponent(firstTicket)}`);
  assert.equal((await ownerSocket.waitFor((message) => message.type === "connected")).type, "connected");
  ownerSocket.socket.send(JSON.stringify({ type: "subscribe_delivery", deliveryId: delivery.id }));
  assert.equal((await ownerSocket.waitFor((message) => message.type === "subscribed")).scope, "delivery");

  await expectHandshakeStatus(`${baseTwo}/api/v1/realtime/socket?ticket=${encodeURIComponent(firstTicket)}`, 401);
  const strangerTicket = await requestTicket(otherCustomer.id, "CUSTOMER");
  const strangerSocket = await connectSocket(`${baseTwo}/api/v1/realtime/socket?ticket=${encodeURIComponent(strangerTicket)}`);
  strangerSocket.socket.send(JSON.stringify({ type: "subscribe_delivery", deliveryId: delivery.id }));
  assert.equal((await strangerSocket.waitFor((message) => message.type === "subscription_error")).code, "SUBSCRIPTION_FORBIDDEN");
  strangerSocket.socket.send(JSON.stringify({ type: "subscribe_active_drivers" }));
  assert.equal((await strangerSocket.waitFor((message) => message.type === "subscription_error")).code, "SUBSCRIPTION_FORBIDDEN");

  const firstLocationTime = new Date(Date.now() - 2_000);
  await deliveryService.updateDriverLocation(delivery.id, driver.id, {
    latitude: 41.7151,
    longitude: 44.8271,
    accuracy: 15,
    timestamp: firstLocationTime.toISOString(),
  });
  const event = await ownerSocket.waitFor((message) => message.type === "driver_location");
  assert.equal(event.deliveryId, delivery.id);
  assert.equal(event.driverId, driver.id);
  assert.equal(event.latitude, 41.7151);

  await closeSocket(ownerSocket.socket);
  const reconnected = await connectSocket(`${baseTwo}/api/v1/realtime/socket?ticket=${encodeURIComponent(await requestTicket(customer.id, "CUSTOMER"))}`);
  await reconnected.waitFor((message) => message.type === "connected");
  reconnected.socket.send(JSON.stringify({ type: "subscribe_delivery", deliveryId: delivery.id }));
  await reconnected.waitFor((message) => message.type === "subscribed");

  await prisma!.delivery.update({ where: { id: delivery.id }, data: { customerId: otherCustomer.id } });
  await deliveryService.updateDriverLocation(delivery.id, driver.id, {
    latitude: 41.716,
    longitude: 44.828,
    timestamp: new Date(firstLocationTime.getTime() + 1_000).toISOString(),
  });
  assert.equal((await reconnected.waitFor((message) => message.type === "subscription_revoked")).scope, "delivery");

  const dispatcherSocket = await connectSocket(`${baseOne}/api/v1/realtime/socket?ticket=${encodeURIComponent(await requestTicket(dispatcher.id, "DISPATCHER"))}`);
  await dispatcherSocket.waitFor((message) => message.type === "connected");
  dispatcherSocket.socket.send(JSON.stringify({ type: "subscribe_active_drivers" }));
  assert.equal((await dispatcherSocket.waitFor((message) => message.type === "subscribed")).scope, "active_drivers");
  await deliveryService.updateDriverLocation(delivery.id, driver.id, {
    latitude: 41.717,
    longitude: 44.829,
    timestamp: new Date(firstLocationTime.getTime() + 2_000).toISOString(),
  });
  const fleetEvent = await dispatcherSocket.waitFor((message) => message.type === "driver_location");
  assert.equal(fleetEvent.driverId, driver.id);

  await closeSocket(ownerSocket.socket);
  await closeSocket(strangerSocket.socket);
  await closeSocket(reconnected.socket);
  await closeSocket(dispatcherSocket.socket);
  assert.equal(await prisma!.delivery.count({ where: { driverId: otherDriver.id } }), 0);
});

test("connection floods are capped per process and peer IP; closed clients release capacity and tickets stay single-use under races", {
  skip: !runIntegration,
}, async () => {
  const appModule = await import("../src/app.js");
  const gatewayModule = await import("../src/modules/realtime/realtime.gateway.js");
  const { createRealtimeTicketService, issueRealtimeTicket } = await import("../src/modules/realtime/ticket.service.js");
  const user = await createUser("CUSTOMER");

  const shortLivedTickets = createRealtimeTicketService(redis!, 1);
  const expired = await shortLivedTickets.issue(user.id);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const expiredAttempts = await Promise.all(Array.from({ length: 16 }, () => shortLivedTickets.consume(expired.ticket)));
  assert.ok(expiredAttempts.every((result) => result === null));

  async function exerciseLimit(
    options: { maxConnections: number; maxConnectionsPerIp: number },
    expectedStatus: number,
    label: string,
  ) {
    const activeConnectionsBefore = metrics!.snapshot().realtime.activeConnections;
    const server = createServer(appModule.default as unknown as Express);
    const gateway = gatewayModule.createRealtimeGateway(server, { ...options, maxBufferedBytes: 1_048_576 });
    const opened: SocketClient[] = [];
    let shutdownSocket: WebSocket | undefined;
    let shutdownCode: Promise<number> | undefined;
    await gateway.start();
    const base = await listen(server);
    try {
      const startedAt = Date.now();
      const tickets = await Promise.all(Array.from({ length: 16 }, () => issueRealtimeTicket(user.id)));
      const attempts = await Promise.allSettled(tickets.map(({ ticket }) =>
        connectSocket(`${base}/api/v1/realtime/socket?ticket=${encodeURIComponent(ticket)}`),
      ));
      opened.push(...attempts.filter((attempt): attempt is PromiseFulfilledResult<SocketClient> => attempt.status === "fulfilled").map((attempt) => attempt.value));
      const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
      assert.equal(opened.length, expectedStatus === 429 ? 12 : 12);
      assert.equal(rejected.length, 4);
      assert.ok(rejected.every((attempt) => String(attempt.reason).includes(`handshake returned ${expectedStatus}`)));
      console.log(`P5.2_WS_LOAD policy=${label} attempted=16 accepted=${opened.length} rejected=${rejected.length} durationMs=${Date.now() - startedAt} isolated=local-test-process`);

      await closeSocket(opened[0].socket);
      opened.splice(0, 1);
      const replacement = await connectSocket(`${base}/api/v1/realtime/socket?ticket=${encodeURIComponent((await issueRealtimeTicket(user.id)).ticket)}`);
      opened.push(replacement);

      await Promise.all(opened.map(({ socket }) => closeSocket(socket)));
      opened.length = 0;

      const duplicateTicket = (await issueRealtimeTicket(user.id)).ticket;
      const concurrent = await Promise.allSettled([
        connectSocket(`${base}/api/v1/realtime/socket?ticket=${encodeURIComponent(duplicateTicket)}`),
        connectSocket(`${base}/api/v1/realtime/socket?ticket=${encodeURIComponent(duplicateTicket)}`),
      ]);
      const winners = concurrent.filter((result): result is PromiseFulfilledResult<SocketClient> => result.status === "fulfilled");
      const losers = concurrent.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      assert.equal(winners.length, 1);
      assert.equal(losers.length, 1);
      assert.match(String(losers[0].reason), /handshake returned 401/);
      shutdownSocket = winners[0].value.socket;
      shutdownCode = new Promise<number>((resolve) => shutdownSocket!.once("close", (code) => resolve(code)));
    } finally {
      await Promise.all(opened.map(({ socket }) => closeSocket(socket)));
      await gateway.close();
      if (shutdownSocket && shutdownCode) {
        const code = await Promise.race([
          shutdownCode,
          new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2_000)),
        ]);
        assert.equal(code, 1001);
      }
      assert.equal(metrics!.snapshot().realtime.activeConnections, activeConnectionsBefore);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  await exerciseLimit({ maxConnections: 100, maxConnectionsPerIp: 12 }, 429, "per_ip");
  await exerciseLimit({ maxConnections: 12, maxConnectionsPerIp: 100 }, 503, "per_process");
});

test("over-buffered location clients are closed while committed GPS history remains available", {
  skip: !runIntegration,
}, async () => {
  const appModule = await import("../src/app.js");
  const gatewayModule = await import("../src/modules/realtime/realtime.gateway.js");
  const deliveryService = await import("../src/modules/deliveries/delivery.service.js");
  const customer = await createUser("CUSTOMER");
  const driver = await createUser("DRIVER");
  const dispatcher = await createUser("DISPATCHER");
  const delivery = await deliveryService.createDelivery(customer.id, {
    recipientName: "Slow Client Recipient",
    recipientPhone: "+15550000001",
    pickupAddress: "10 Slow Client Pickup Road",
    deliveryAddress: "20 Slow Client Delivery Road",
  }, customer.id, "CUSTOMER");
  deliveryIds.push(delivery.id);
  await deliveryService.assignDriver(delivery.id, driver.id, dispatcher.id, "DISPATCHER");
  await deliveryService.updateDeliveryStatus(delivery.id, { id: driver.id, role: "DRIVER" }, "PICKED_UP");

  const server = createServer(appModule.default as unknown as Express);
  const gateway = gatewayModule.createRealtimeGateway(server, {
    maxConnections: 2,
    maxConnectionsPerIp: 2,
    maxBufferedBytes: 0,
  });
  await gateway.start();
  const base = await listen(server);
  const socket = await connectSocket(`${base}/api/v1/realtime/socket?ticket=${encodeURIComponent(await requestTicket(customer.id, "CUSTOMER"))}`);
  await socket.waitFor((message) => message.type === "connected");
  socket.socket.send(JSON.stringify({ type: "subscribe_delivery", deliveryId: delivery.id }));
  await socket.waitFor((message) => message.type === "subscribed");
  const backpressureBefore = metrics!.snapshot().realtime.backpressureEvents;
  const closed = new Promise<number>((resolve) => socket.socket.once("close", (code) => resolve(code)));
  const recordedAt = new Date(Date.now() - 1_000);
  try {
    await deliveryService.updateDriverLocation(delivery.id, driver.id, {
      latitude: 41.7,
      longitude: 44.8,
      timestamp: recordedAt.toISOString(),
    });
    assert.equal(await closed, 1013);
    assert.equal(metrics!.snapshot().realtime.backpressureEvents, backpressureBefore + 1);
    assert.equal(await prisma!.driverLocation.count({ where: { deliveryId: delivery.id } }), 1);
  } finally {
    await closeSocket(socket.socket);
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Redis Pub/Sub reconnects on both instances; GPS committed during interruption is not replayed but remains queryable", {
  skip: !runIntegration,
}, async () => {
  const deliveryService = await import("../src/modules/deliveries/delivery.service.js");
  const customer = await createUser("CUSTOMER");
  const driver = await createUser("DRIVER");
  const dispatcher = await createUser("DISPATCHER");
  const delivery = await deliveryService.createDelivery(customer.id, {
    recipientName: "Redis Recovery Recipient",
    recipientPhone: "+15550000002",
    pickupAddress: "10 Redis Recovery Pickup Road",
    deliveryAddress: "20 Redis Recovery Delivery Road",
  }, customer.id, "CUSTOMER");
  deliveryIds.push(delivery.id);
  await deliveryService.assignDriver(delivery.id, driver.id, dispatcher.id, "DISPATCHER");
  await deliveryService.updateDeliveryStatus(delivery.id, { id: driver.id, role: "DRIVER" }, "PICKED_UP");

  const socket = await connectSocket(`${baseTwo}/api/v1/realtime/socket?ticket=${encodeURIComponent(await requestTicket(customer.id, "CUSTOMER"))}`);
  await socket.waitFor((message) => message.type === "connected");
  socket.socket.send(JSON.stringify({ type: "subscribe_delivery", deliveryId: delivery.id }));
  await socket.waitFor((message) => message.type === "subscribed");
  const basePubSubConnections = metrics!.snapshot().realtime.pubSubConnections;
  assert.ok(basePubSubConnections >= 2);

  const interruptedAt = new Date(Date.now() - 3_000);
  let replayedInterruptedPoint = false;
  socket.socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "driver_location" && message.recordedAt === interruptedAt.toISOString()) replayedInterruptedPoint = true;
    } catch { /* Ignore malformed test client messages. */ }
  });

  await redis!.call("CLIENT", "KILL", "TYPE", "pubsub");
  await waitUntil(() => metrics!.snapshot().realtime.pubSubConnections === 0);
  await deliveryService.updateDriverLocation(delivery.id, driver.id, {
    latitude: 41.71,
    longitude: 44.81,
    timestamp: interruptedAt.toISOString(),
  });
  assert.equal(await prisma!.driverLocation.count({ where: { deliveryId: delivery.id } }), 1);
  await waitUntil(() => metrics!.snapshot().realtime.pubSubConnections >= basePubSubConnections);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(replayedInterruptedPoint, false);

  const recoveredAt = new Date(interruptedAt.getTime() + 1_000);
  await deliveryService.updateDriverLocation(delivery.id, driver.id, {
    latitude: 41.72,
    longitude: 44.82,
    timestamp: recoveredAt.toISOString(),
  });
  const recoveredEvent = await socket.waitFor((message) => message.type === "driver_location" && message.recordedAt === recoveredAt.toISOString());
  assert.equal(recoveredEvent.deliveryId, delivery.id);
  assert.equal(await prisma!.driverLocation.count({ where: { deliveryId: delivery.id } }), 2);
  await closeSocket(socket.socket);
});

test("GPS persistence succeeds and records a failed transient publish when the Redis command client is unavailable", {
  skip: !runIntegration,
}, async () => {
  const deliveryService = await import("../src/modules/deliveries/delivery.service.js");
  const customer = await createUser("CUSTOMER");
  const driver = await createUser("DRIVER");
  const dispatcher = await createUser("DISPATCHER");
  const delivery = await deliveryService.createDelivery(customer.id, {
    recipientName: "Redis Down Recipient",
    recipientPhone: "+15550000003",
    pickupAddress: "10 Redis Down Pickup Road",
    deliveryAddress: "20 Redis Down Delivery Road",
  }, customer.id, "CUSTOMER");
  deliveryIds.push(delivery.id);
  await deliveryService.assignDriver(delivery.id, driver.id, dispatcher.id, "DISPATCHER");
  await deliveryService.updateDeliveryStatus(delivery.id, { id: driver.id, role: "DRIVER" }, "PICKED_UP");

  const failuresBefore = metrics!.snapshot().realtime.failedBroadcasts;
  const startedAt = Date.now();
  redis!.disconnect();
  try {
    await deliveryService.updateDriverLocation(delivery.id, driver.id, {
      latitude: 41.73,
      longitude: 44.83,
      timestamp: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(await prisma!.driverLocation.count({ where: { deliveryId: delivery.id } }), 1);
    assert.equal(metrics!.snapshot().realtime.failedBroadcasts, failuresBefore + 1);
    assert.ok(Date.now() - startedAt < env.REALTIME_PUBLISH_TIMEOUT_MS + 1_000);
  } finally {
    if (redis!.status === "end") await redis!.connect();
    await redis!.ping();
  }
});
