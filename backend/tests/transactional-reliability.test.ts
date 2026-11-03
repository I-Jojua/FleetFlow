import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprintRequest, validateIdempotencyKey } from "../src/modules/idempotency/idempotency.service.js";
import { validateEnvironment } from "../src/config/env.js";

test("idempotency keys have bounded safe characters and request fingerprints are canonical", () => {
  assert.equal(validateIdempotencyKey("req-12345678"), true);
  assert.equal(validateIdempotencyKey("a".repeat(128)), true);
  assert.equal(validateIdempotencyKey("short"), false);
  assert.equal(validateIdempotencyKey("bad key 123"), false);
  assert.equal(validateIdempotencyKey("a".repeat(129)), false);

  assert.equal(
    fingerprintRequest({ delivery: { customerId: "customer-1", notes: "x" }, limit: 3 }),
    fingerprintRequest({ limit: 3, delivery: { notes: "x", customerId: "customer-1" } }),
  );
  assert.notEqual(fingerprintRequest({ status: "PENDING" }), fingerprintRequest({ status: "CANCELLED" }));
});

test("idempotency retention and outbox recovery settings reject unsafe bounds", () => {
  assert.equal(validateEnvironment({ NODE_ENV: "test" }).IDEMPOTENCY_KEY_TTL_HOURS, 24);
  assert.equal(validateEnvironment({ NODE_ENV: "test" }).OUTBOX_MAX_ATTEMPTS, 8);
  assert.throws(() => validateEnvironment({ NODE_ENV: "test", IDEMPOTENCY_KEY_TTL_HOURS: "0" }), /IDEMPOTENCY_KEY_TTL_HOURS/);
  assert.throws(() => validateEnvironment({ NODE_ENV: "test", OUTBOX_BATCH_SIZE: "501" }), /OUTBOX_BATCH_SIZE/);
  assert.throws(() => validateEnvironment({ NODE_ENV: "test", OUTBOX_LOCK_TIMEOUT_MS: "999" }), /OUTBOX_LOCK_TIMEOUT_MS/);
});
