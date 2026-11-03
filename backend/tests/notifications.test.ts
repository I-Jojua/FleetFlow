import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { prisma } from "../src/config/prisma.js";
import { env } from "../src/config/env.js";
import * as deliveryService from "../src/modules/deliveries/delivery.service.js";
import * as notificationService from "../src/modules/notifications/notification.service.js";

const customerId = "00000000-0000-4000-8000-000000000001";
const driverId = "00000000-0000-4000-8000-000000000002";
const deliveryId = "00000000-0000-4000-8000-000000000003";
const notificationId = "00000000-0000-4000-8000-000000000004";
const trackingCode = "FF-TEST123456";

function setWebhook(t: TestContext, value: string | undefined) {
  const previousValue = env.SLACK_WEBHOOK_URL;
  env.SLACK_WEBHOOK_URL = value;
  t.after(() => {
    env.SLACK_WEBHOOK_URL = previousValue;
  });
}

function mockNotificationCreate(
  t: TestContext,
  calls: Array<{ userId: string; deliveryId?: string; type: string; title: string; message: string }>,
) {
  replaceMethod(t, prisma.notification, "create", async (args: { data: typeof calls[number] }) => {
      calls.push(args.data);
      return { id: notificationId, ...args.data };
    });
}

function mockTransaction(
  t: TestContext,
  transactionClient: object,
) {
  replaceMethod(t, prisma, "$transaction", async (callback: (tx: object) => unknown) => {
    const tx = transactionClient as Record<string, any>;
    tx.auditLog ??= { create: async ({ data }: { data: unknown }) => ({ id: "audit-test-record", ...data as object }) };
    return callback(tx);
  });
}

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

function deliveryRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: deliveryId,
    trackingCode,
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
    notes: null,
    assignedAt: null,
    pickedUpAt: null,
    deliveredAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createDeliveryTransaction(t: TestContext) {
  const created = deliveryRecord();
  mockTransaction(t, {
    user: { findFirst: async () => ({ id: customerId }) },
    delivery: {
      create: async () => created,
    },
    deliveryEvent: {
      create: async () => ({}),
    },
  });
  return created;
}

test("delivery creation sends a customer notification", async (t) => {
  setWebhook(t, undefined);
  const created = createDeliveryTransaction(t);
  const notifications: Array<{ userId: string; deliveryId?: string; type: string; title: string; message: string }> = [];
  mockNotificationCreate(t, notifications);

  const delivery = await deliveryService.createDelivery(customerId, {
    recipientName: "Test Recipient",
    recipientPhone: "+995555000000",
    pickupAddress: "Test pickup address",
    deliveryAddress: "Test delivery address",
  });

  assert.equal(delivery.id, created.id);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].userId, customerId);
  assert.equal(notifications[0].deliveryId, deliveryId);
  assert.match(notifications[0].message, /has been created/);
});

test("driver assignment sends a notification to the assigned driver", async (t) => {
  setWebhook(t, undefined);
  const pendingDelivery = deliveryRecord();
  const assignedDelivery = deliveryRecord({ driverId, status: "ASSIGNED" });
  const notifications: Array<{ userId: string; deliveryId?: string; type: string; title: string; message: string }> = [];
  mockNotificationCreate(t, notifications);
  let findUniqueCalls = 0;
  mockTransaction(t, {
    delivery: {
      findUnique: async () =>
        findUniqueCalls++ === 0 ? pendingDelivery : assignedDelivery,
      updateMany: async () => ({ count: 1 }),
    },
    deliveryEvent: { create: async () => ({}) },
    user: {
      findFirst: async () => ({ id: driverId, firstName: "Test", lastName: "Driver" }),
    },
  });

  const delivery = await deliveryService.assignDriver(
    deliveryId,
    driverId,
    customerId,
    "ADMIN",
  );

  assert.equal(delivery.status, "ASSIGNED");
  assert.ok(notifications.some((item) => item.userId === driverId && item.title === "Delivery assigned to you"));
});

test("delivery status changes notify the customer and assigned driver", async (t) => {
  setWebhook(t, undefined);
  const currentDelivery = deliveryRecord({ driverId, status: "IN_TRANSIT" });
  const deliveredDelivery = deliveryRecord({ driverId, status: "DELIVERED" });
  const notifications: Array<{ userId: string; deliveryId?: string; type: string; title: string; message: string }> = [];
  mockNotificationCreate(t, notifications);
  let findUniqueCalls = 0;
  mockTransaction(t, {
    delivery: {
      findUnique: async () =>
        findUniqueCalls++ === 0 ? currentDelivery : deliveredDelivery,
      updateMany: async () => ({ count: 1 }),
    },
    deliveryEvent: { create: async () => ({}) },
  });

  const delivery = await deliveryService.updateDeliveryStatus(
    deliveryId,
    { id: driverId, role: "DRIVER" },
    "DELIVERED",
  );

  assert.equal(delivery.status, "DELIVERED");
  assert.deepEqual(new Set(notifications.map((item) => item.userId)), new Set([customerId, driverId]));
  assert.ok(notifications.every((item) => item.message.includes("now delivered")));
});

test("delivery creation sends a Slack alert when the webhook is configured", async (t) => {
  setWebhook(t, "https://hooks.slack.com/services/test/test/test");
  const created = createDeliveryTransaction(t);
  const notifications: Array<{ userId: string; deliveryId?: string; type: string; title: string; message: string }> = [];
  mockNotificationCreate(t, notifications);
  let request: { url: string; init?: RequestInit } | undefined;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), init };
    return new Response("ok", { status: 200 });
  });

  const delivery = await deliveryService.createDelivery(customerId, {
    recipientName: "Test Recipient",
    recipientPhone: "+995555000000",
    pickupAddress: "Test pickup address",
    deliveryAddress: "Test delivery address",
  });

  assert.equal(delivery.id, created.id);
  assert.equal(request?.url, "https://hooks.slack.com/services/test/test/test");
  assert.equal(request?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    text: `New delivery created: ${trackingCode}`,
  });
});

test("missing Slack webhook does not break delivery creation", async (t) => {
  setWebhook(t, undefined);
  const created = createDeliveryTransaction(t);
  const notifications: Array<{ userId: string; deliveryId?: string; type: string; title: string; message: string }> = [];
  mockNotificationCreate(t, notifications);
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalled = true;
    return new Response("ok");
  });

  const delivery = await deliveryService.createDelivery(customerId, {
    recipientName: "Test Recipient",
    recipientPhone: "+995555000000",
    pickupAddress: "Test pickup address",
    deliveryAddress: "Test delivery address",
  });

  assert.equal(delivery.id, created.id);
  assert.equal(fetchCalled, false);
});

test("Slack delivery failure does not break delivery creation", async (t) => {
  setWebhook(t, "https://hooks.slack.com/services/test/test/test");
  const created = createDeliveryTransaction(t);
  const notifications: Array<{ userId: string; deliveryId?: string; type: string; title: string; message: string }> = [];
  mockNotificationCreate(t, notifications);
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Simulated Slack network failure");
  });

  const delivery = await deliveryService.createDelivery(customerId, {
    recipientName: "Test Recipient",
    recipientPhone: "+995555000000",
    pickupAddress: "Test pickup address",
    deliveryAddress: "Test delivery address",
  });

  assert.equal(delivery.id, created.id);
  assert.equal(notifications.length, 1);
});

test("Slack non-success response does not break delivery creation", async (t) => {
  setWebhook(t, "https://hooks.slack.com/services/test/test/test");
  const created = createDeliveryTransaction(t);
  const notifications: Array<{ userId: string; deliveryId?: string; type: string; title: string; message: string }> = [];
  mockNotificationCreate(t, notifications);
  replaceMethod(t, console, "warn", () => undefined);
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));

  const delivery = await deliveryService.createDelivery(customerId, {
    recipientName: "Test Recipient",
    recipientPhone: "+995555000000",
    pickupAddress: "Test pickup address",
    deliveryAddress: "Test delivery address",
  });

  assert.equal(delivery.id, created.id);
  assert.equal(notifications.length, 1);
});

test("notification list and unread count use the unread filter", async (t) => {
  let findManyArgs: { where: { userId: string; isRead?: boolean } } | undefined;
  let countArgs: { where: { userId: string; isRead?: boolean } } | undefined;
  replaceMethod(t, prisma.notification, "findMany", async (args: typeof findManyArgs) => {
    findManyArgs = args;
    return [];
  });
  replaceMethod(t, prisma.notification, "count", async (args: typeof countArgs) => {
    countArgs = args;
    return 3;
  });

  const page = await notificationService.getNotifications(customerId, 1, 10, true);
  const unreadCount = await notificationService.getUnreadCount(customerId);

  assert.deepEqual(findManyArgs?.where, { userId: customerId, isRead: false });
  assert.deepEqual(countArgs?.where, { userId: customerId, isRead: false });
  assert.equal(page.pagination.total, 3);
  assert.equal(unreadCount, 3);
});

test("marking a notification read updates its timestamp and is idempotent", async (t) => {
  let updateCalls = 0;
  let isAlreadyRead = false;
  replaceMethod(t, prisma.notification, "findFirst", async () => ({
    id: notificationId,
    userId: customerId,
    isRead: isAlreadyRead,
    readAt: isAlreadyRead ? new Date("2026-01-01T00:00:00.000Z") : null,
  }));
  replaceMethod(t, prisma.notification, "update", async (args: { data: { isRead: boolean; readAt: Date } }) => {
    updateCalls += 1;
    return { id: notificationId, ...args.data };
  });

  const updated = await notificationService.markAsRead(customerId, notificationId);
  assert.equal(updated?.isRead, true);
  assert.ok(updated?.readAt instanceof Date);
  assert.equal(updateCalls, 1);

  isAlreadyRead = true;
  const alreadyRead = await notificationService.markAsRead(customerId, notificationId);
  assert.equal(alreadyRead?.isRead, true);
  assert.equal(updateCalls, 1);
});

test("mark all as read updates only unread notifications", async (t) => {
  let updateManyArgs: { where: { userId: string; isRead: boolean }; data: { isRead: boolean; readAt: Date } } | undefined;
  replaceMethod(t, prisma.notification, "updateMany", async (args: typeof updateManyArgs) => {
    updateManyArgs = args;
    return { count: 4 };
  });

  const result = await notificationService.markAllAsRead(customerId);

  assert.deepEqual(updateManyArgs?.where, { userId: customerId, isRead: false });
  assert.equal(updateManyArgs?.data.isRead, true);
  assert.ok(updateManyArgs?.data.readAt instanceof Date);
  assert.deepEqual(result, { updatedCount: 4 });
});
