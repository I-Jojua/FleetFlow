import assert from "node:assert/strict";
import { test } from "node:test";
import { createRealtimeTicketService } from "../src/modules/realtime/ticket.service.js";
import { realtimeClientMessageSchema, realtimeLocationEventSchema } from "../src/modules/realtime/realtime.validation.js";
import { RATE_LIMIT_POLICIES } from "../src/middleware/rate-limit.middleware.js";

test("realtime tickets are opaque, expire through the store, and can be consumed once", async () => {
  let now = 1_000;
  const records = new Map<string, { userId: string; expiresAt: number; ttl: number }>();
  const service = createRealtimeTicketService({
    async set(key, userId, mode, ttl, condition) {
      assert.equal(mode, "EX");
      assert.equal(condition, "NX");
      records.set(key, { userId, ttl, expiresAt: now + ttl * 1_000 });
      return "OK";
    },
    async getdel(key) {
      const record = records.get(key);
      records.delete(key);
      return record && record.expiresAt > now ? record.userId : null;
    },
  }, 30);

  const issued = await service.issue("user-id");
  assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresInSeconds, 30);
  assert.equal([...records.values()][0].ttl, 30);
  assert.equal(await service.consume(issued.ticket), "user-id");
  assert.equal(await service.consume(issued.ticket), null);
  assert.equal(await service.consume("short"), null);

  const expiring = await service.issue("expiring-user");
  now += 30_000;
  assert.equal(await service.consume(expiring.ticket), null);
});

test("concurrent ticket consumption has exactly one winner", async () => {
  const records = new Map<string, string>();
  const service = createRealtimeTicketService({
    async set(key, userId) { records.set(key, userId); return "OK"; },
    async getdel(key) {
      const userId = records.get(key) ?? null;
      records.delete(key);
      return userId;
    },
  });
  const { ticket } = await service.issue("single-use-user");
  const outcomes = await Promise.all(Array.from({ length: 32 }, () => service.consume(ticket)));
  assert.equal(outcomes.filter((value) => value === "single-use-user").length, 1);
  assert.equal(outcomes.filter((value) => value === null).length, 31);
});

test("realtime subscription messages are strict and location events validate coordinates", () => {
  const deliveryId = "00000000-0000-4000-8000-000000000001";
  assert.equal(realtimeClientMessageSchema.safeParse({ type: "subscribe_delivery", deliveryId }).success, true);
  assert.equal(realtimeClientMessageSchema.safeParse({ type: "subscribe_delivery", deliveryId, driverId: "spoofed" }).success, false);
  assert.equal(realtimeClientMessageSchema.safeParse({ type: "subscribe_active_drivers" }).success, true);
  assert.equal(realtimeLocationEventSchema.safeParse({
    type: "driver_location",
    driverId: deliveryId,
    deliveryId,
    latitude: 91,
    longitude: 0,
    accuracy: null,
    recordedAt: new Date().toISOString(),
  }).success, false);
  assert.equal(RATE_LIMIT_POLICIES.realtimeTicket.maxRequests, 20);
});
