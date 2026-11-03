import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Request, Response } from "express";

import { validateEnvironment } from "../src/config/env.js";
import { registerSchema } from "../src/modules/auth/auth.validation.js";
import { isStaffRole } from "../src/modules/auth/authorization.js";
import { prisma } from "../src/config/prisma.js";
import { errorHandler } from "../src/middleware/error.middleware.js";
import {
  createRedisRateLimitStore,
  createRateLimiter,
  RATE_LIMIT_POLICIES,
  type RateLimitCounter,
  type RateLimitStore,
} from "../src/middleware/rate-limit.middleware.js";
import { trackDelivery } from "../src/modules/deliveries/delivery.service.js";
import { createLogger } from "../src/utils/logger.js";
import { requestLogger } from "../src/middleware/request-logger.middleware.js";
import { getReadiness } from "../src/modules/health/health.service.js";
import { createReadinessHandler } from "../src/modules/health/health.routes.js";
import { createGracefulShutdown } from "../src/server/graceful-shutdown.js";

const DEFAULT_ACCESS_SECRET = "development_access_secret_change_this";
const DEFAULT_REFRESH_SECRET = "development_refresh_secret_change_this";

function mockResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;

  const response = {
    headers,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return response;
    },
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  };

  return response;
}

class FakeRedisCounterClient {
  readonly counters = new Map<string, { count: number; expiresAt: number }>();
  now = 1_000;

  async eval(script: string, numberOfKeys: number, key: string, windowMs: string) {
    assert.equal(numberOfKeys, 1);
    assert.match(script, /INCR/);
    assert.match(script, /PEXPIRE/);
    assert.match(script, /PTTL/);
    const duration = Number(windowMs);
    let counter = this.counters.get(key);
    if (!counter || counter.expiresAt <= this.now) {
      counter = { count: 0, expiresAt: this.now + duration };
    }
    counter.count += 1;
    this.counters.set(key, counter);
    return [counter.count, counter.expiresAt - this.now];
  }
}

function invokeLimiter(limiter: ReturnType<typeof createRateLimiter>, ip: string) {
  let nextCalls = 0;
  const response = mockResponse();
  const promise = limiter(
    { ip, socket: { remoteAddress: ip } } as Request,
    response as unknown as Response,
    () => { nextCalls += 1; },
  );
  return Promise.resolve(promise).then(() => ({ response, nextCalls }));
}

function replaceMethod(
  t: import("node:test").TestContext,
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

test("production configuration rejects missing database URL and default JWT secrets without exposing values", () => {
  assert.throws(
    () => validateEnvironment({ NODE_ENV: "production" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /JWT_ACCESS_SECRET/);
      assert.match(error.message, /JWT_REFRESH_SECRET/);
      assert.doesNotMatch(error.message, /fleetflow_dev_password/);
      assert.doesNotMatch(error.message, new RegExp(DEFAULT_ACCESS_SECRET));
      assert.doesNotMatch(error.message, new RegExp(DEFAULT_REFRESH_SECRET));
      return true;
    },
  );
});

test("production configuration accepts explicit PostgreSQL URL and distinct long JWT secrets", () => {
  const productionSettings = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://fleetflow:example-password@db.example.test:5432/fleetflow",
    REDIS_URL: "rediss://fleetflow:example-password@cache.example.test:6379",
    CORS_ALLOWED_ORIGINS: "https://app.example.test,https://admin.example.test",
    EMAIL_PROVIDER: "resend",
    EMAIL_API_KEY: "test-email-api-key",
    EMAIL_FROM: "no-reply@example.test",
    APP_BASE_URL: "https://app.example.test",
    EMAIL_TOKEN_ENCRYPTION_KEY: "c".repeat(64),
    JWT_ACCESS_SECRET: "a".repeat(48),
    JWT_REFRESH_SECRET: "b".repeat(48),
  };
  const config = validateEnvironment(productionSettings);

  assert.equal(config.NODE_ENV, "production");
  assert.equal(config.PORT, 5000);
  assert.equal(config.API_DOCS_ENABLED, false);
  assert.deepEqual(config.CORS_ALLOWED_ORIGINS, [
    "https://app.example.test",
    "https://admin.example.test",
  ]);
  assert.throws(
    () => validateEnvironment({ ...productionSettings, APP_BASE_URL: "http://app.example.test" }),
    /APP_BASE_URL/,
  );
});

test("Swagger UI is enabled by default outside production and production access requires a token", () => {
  assert.equal(validateEnvironment({ NODE_ENV: "development" }).API_DOCS_ENABLED, true);
  assert.equal(validateEnvironment({ NODE_ENV: "test" }).API_DOCS_ENABLED, true);

  const production = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://fleetflow:example-password@db.example.test:5432/fleetflow",
    REDIS_URL: "rediss://fleetflow:example-password@cache.example.test:6379",
    CORS_ALLOWED_ORIGINS: "https://app.example.test",
    EMAIL_PROVIDER: "resend",
    EMAIL_API_KEY: "test-email-api-key",
    EMAIL_FROM: "no-reply@example.test",
    APP_BASE_URL: "https://app.example.test",
    EMAIL_TOKEN_ENCRYPTION_KEY: "c".repeat(64),
    JWT_ACCESS_SECRET: "a".repeat(48),
    JWT_REFRESH_SECRET: "b".repeat(48),
    API_DOCS_ENABLED: "true",
  };
  assert.throws(() => validateEnvironment(production), /API_DOCS_ACCESS_TOKEN/);
  const configured = validateEnvironment({ ...production, API_DOCS_ACCESS_TOKEN: "d".repeat(48) });
  assert.equal(configured.API_DOCS_ENABLED, true);
});

test("development defaults remain available and invalid field errors omit secret values", () => {
  assert.equal(validateEnvironment({ NODE_ENV: "development" }).NODE_ENV, "development");

  const suppliedSecret = "short-private-value";
  assert.throws(
    () => validateEnvironment({ NODE_ENV: "test", JWT_ACCESS_SECRET: suppliedSecret }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /JWT_ACCESS_SECRET/);
      assert.doesNotMatch(error.message, new RegExp(suppliedSecret));
      return true;
    },
  );
});

test("public registration cannot inject an elevated role or delivery ownership ID", () => {
  const input = registerSchema.parse({
    firstName: "Test",
    lastName: "Customer",
    email: "test.customer@example.test",
    password: "safe-test-password",
    role: "SUPER_ADMIN",
    customerId: "123e4567-e89b-12d3-a456-426614174000",
  });
  assert.equal("role" in input, false);
  assert.equal("customerId" in input, false);
});

test("staff resource scope includes only dispatcher and administrator roles", () => {
  assert.equal(isStaffRole("SUPER_ADMIN"), true);
  assert.equal(isStaffRole("ADMIN"), true);
  assert.equal(isStaffRole("DISPATCHER"), true);
  assert.equal(isStaffRole("DRIVER"), false);
  assert.equal(isStaffRole("CUSTOMER"), false);
});

test("rate-limit policies use different endpoint limits", () => {
  assert.equal(RATE_LIMIT_POLICIES.login.maxRequests, 10);
  assert.equal(RATE_LIMIT_POLICIES.register.maxRequests, 5);
  assert.equal(RATE_LIMIT_POLICIES.refresh.maxRequests, 30);
  assert.equal(RATE_LIMIT_POLICIES.publicTracking.maxRequests, 60);
  assert.equal(RATE_LIMIT_POLICIES.verifyEmail.maxRequests, 10);
  assert.equal(RATE_LIMIT_POLICIES.resendVerification.maxRequests, 5);
  assert.equal(RATE_LIMIT_POLICIES.passwordResetRequest.maxRequests, 5);
  assert.equal(RATE_LIMIT_POLICIES.passwordResetConfirm.maxRequests, 10);
  assert.equal(RATE_LIMIT_POLICIES.auditRead.maxRequests, 60);
  assert.notEqual(RATE_LIMIT_POLICIES.login.windowMs, RATE_LIMIT_POLICIES.register.windowMs);
});

test("rate limiter returns a consistent JSON 429 response and Retry-After header", async () => {
  const sharedClient = new FakeRedisCounterClient();
  const store = createRedisRateLimitStore(sharedClient);
  const limit = createRateLimiter(
    { key: "test-policy", windowMs: 60_000, maxRequests: 1 },
    { store, environment: "test" },
  );

  const first = await invokeLimiter(limit, "192.0.2.10");
  const second = await invokeLimiter(limit, "192.0.2.10");
  assert.equal(first.nextCalls, 1);
  assert.equal(second.nextCalls, 0);
  assert.equal(second.response.statusCode, 429);
  assert.ok(Number(second.response.headers["Retry-After"]) >= 1);
  assert.deepEqual(second.response.body, {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many requests. Please try again later.",
  });
});

test("rate limiter keeps separate client IP buckets", async () => {
  const store = createRedisRateLimitStore(new FakeRedisCounterClient());
  const limit = createRateLimiter(
    { key: "ip-policy", windowMs: 60_000, maxRequests: 1 },
    { store, environment: "test" },
  );
  for (const ip of ["192.0.2.11", "192.0.2.12"]) {
    const result = await invokeLimiter(limit, ip);
    assert.equal(result.nextCalls, 1);
  }
});

test("separate limiter instances share Redis counters and expiration resets their window", async () => {
  const fakeRedis = new FakeRedisCounterClient();
  const firstStore = createRedisRateLimitStore(fakeRedis);
  const secondStore = createRedisRateLimitStore(fakeRedis);
  const firstProcessLimiter = createRateLimiter(
    { key: "shared", windowMs: 1_000, maxRequests: 1 },
    { store: firstStore, environment: "test", now: () => fakeRedis.now },
  );
  const secondProcessLimiter = createRateLimiter(
    { key: "shared", windowMs: 1_000, maxRequests: 1 },
    { store: secondStore, environment: "test", now: () => fakeRedis.now },
  );

  assert.equal((await invokeLimiter(firstProcessLimiter, "192.0.2.20")).nextCalls, 1);
  const sharedHit = await invokeLimiter(secondProcessLimiter, "192.0.2.20");
  assert.equal(sharedHit.response.statusCode, 429);

  fakeRedis.now += 1_001;
  const afterExpiry = await invokeLimiter(secondProcessLimiter, "192.0.2.20");
  assert.equal(afterExpiry.nextCalls, 1);
  assert.ok(fakeRedis.counters.size >= 1);
});

test("Redis failures fall back locally in development but fail closed in production", async () => {
  let storeCalls = 0;
  const failingStore: RateLimitStore = {
    async increment(): Promise<RateLimitCounter> {
      storeCalls += 1;
      throw new Error("sensitive redis connection details");
    },
  };
  const developmentLimiter = createRateLimiter(
    { key: "dev-failure", windowMs: 60_000, maxRequests: 1 },
    { store: failingStore, environment: "development" },
  );
  const developmentFirst = await invokeLimiter(developmentLimiter, "192.0.2.21");
  const developmentSecond = await invokeLimiter(developmentLimiter, "192.0.2.21");
  assert.equal(developmentFirst.nextCalls, 1);
  assert.equal(developmentSecond.response.statusCode, 429);

  const productionLimiter = createRateLimiter(
    { key: "prod-failure", windowMs: 60_000, maxRequests: 1 },
    { store: failingStore, environment: "production" },
  );
  const productionFailure = await invokeLimiter(productionLimiter, "192.0.2.22");
  assert.equal(productionFailure.nextCalls, 0);
  assert.equal(productionFailure.response.statusCode, 503);
  assert.deepEqual(productionFailure.response.body, {
    success: false,
    code: "RATE_LIMIT_STORE_UNAVAILABLE",
    message: "Request protection is temporarily unavailable.",
  });
  assert.equal(storeCalls, 3);
});

test("CORS origins reject wildcards and malformed values", () => {
  assert.throws(() => validateEnvironment({ CORS_ALLOWED_ORIGINS: "*" }), /CORS_ALLOWED_ORIGINS/);
  assert.throws(() => validateEnvironment({ CORS_ALLOWED_ORIGINS: " , " }), /CORS_ALLOWED_ORIGINS/);
  assert.throws(
    () => validateEnvironment({ CORS_ALLOWED_ORIGINS: "https://example.test/path" }),
    /CORS_ALLOWED_ORIGINS/,
  );
  assert.throws(
    () => validateEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pass@db.example.test:5432/fleetflow",
      REDIS_URL: "redis://cache.example.test:6379",
      JWT_ACCESS_SECRET: "a".repeat(48),
      JWT_REFRESH_SECRET: "b".repeat(48),
    }),
    /CORS_ALLOWED_ORIGINS/,
  );
});

test("GPS configuration validates age, future skew, stale threshold, and retention bounds", () => {
  const config = validateEnvironment({
    GPS_MAX_AGE_SECONDS: "600",
    GPS_MAX_FUTURE_SKEW_SECONDS: "15",
    GPS_STALE_AFTER_SECONDS: "180",
    GPS_LOCATION_RETENTION_DAYS: "60",
  });
  assert.equal(config.GPS_MAX_AGE_SECONDS, 600);
  assert.equal(config.GPS_MAX_FUTURE_SKEW_SECONDS, 15);
  assert.equal(config.GPS_STALE_AFTER_SECONDS, 180);
  assert.equal(config.GPS_LOCATION_RETENTION_DAYS, 60);
  assert.throws(() => validateEnvironment({ GPS_MAX_AGE_SECONDS: "10" }), /GPS_MAX_AGE_SECONDS/);
  assert.throws(() => validateEnvironment({ GPS_STALE_AFTER_SECONDS: "1" }), /GPS_STALE_AFTER_SECONDS/);
  assert.throws(() => validateEnvironment({ GPS_LOCATION_RETENTION_DAYS: "0" }), /GPS_LOCATION_RETENTION_DAYS/);
});

test("public tracking query omits recipient identity, addresses, and event descriptions", async (t) => {
  let query: { select: Record<string, unknown> } | undefined;
  replaceMethod(t, prisma.delivery, "findUnique", async (args: typeof query) => {
    query = args;
    return {
      trackingCode: "FF-TEST123456",
      status: "IN_TRANSIT",
      createdAt: new Date(),
      assignedAt: new Date(),
      pickedUpAt: new Date(),
      deliveredAt: null,
      events: [{ status: "IN_TRANSIT", createdAt: new Date() }],
    };
  });

  const result = await trackDelivery("FF-TEST123456");
  const selection = query?.select;
  const eventSelection = (selection?.events as { select: Record<string, unknown> }).select;

  assert.equal("recipientName" in (selection ?? {}), false);
  assert.equal("pickupAddress" in (selection ?? {}), false);
  assert.equal("deliveryAddress" in (selection ?? {}), false);
  assert.deepEqual(Object.keys(eventSelection).sort(), ["createdAt", "status"]);
  assert.equal("recipientName" in (result ?? {}), false);
});

test("generic API errors never echo sensitive error text in logs or responses", (t) => {
  const sensitiveMarker = "private-database-secret-marker";
  const response = mockResponse();
  const logged: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });

  errorHandler(
    new Error(sensitiveMarker),
    {} as Request,
    response as unknown as Response,
    () => undefined,
  );

  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(sensitiveMarker));
  assert.doesNotMatch(logged.join(" "), new RegExp(sensitiveMarker));
  assert.deepEqual(response.body, {
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal server error.",
  });
});

test("Docker database and Redis ports bind to localhost only", async () => {
  const compose = await readFile(
    resolve(process.cwd(), "..", "docker-compose.yml"),
    "utf8",
  );

  assert.match(compose, /127\.0\.0\.1:5432:5432/);
  assert.match(compose, /127\.0\.0\.1:6379:6379/);
  assert.doesNotMatch(compose, /"5432:5432"/);
  assert.doesNotMatch(compose, /"6379:6379"/);
});
