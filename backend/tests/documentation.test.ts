import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Request, Response } from "express";
import { createMetricsRecorder } from "../src/observability/metrics.js";
import { createMetricsAccessHandler } from "../src/modules/health/health.routes.js";
import { createDocsAccessHandler } from "../src/modules/docs/docs.routes.js";
import { runWithRequestContext } from "../src/observability/request-context.js";
import { createLogger } from "../src/utils/logger.js";

function mockResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  const response = {
    headers,
    get statusCode() { return statusCode; },
    get body() { return body; },
    setHeader(name: string, value: string) { headers[name] = value; return response; },
    status(code: number) { statusCode = code; return response; },
    json(value: unknown) { body = value; return response; },
  };
  return response;
}

function invokeAccessHandler(
  handler: ReturnType<typeof createDocsAccessHandler> | ReturnType<typeof createMetricsAccessHandler>,
  authorization?: string,
) {
  let nextCalls = 0;
  const response = mockResponse();
  const request = {
    get(name: string) { return name.toLowerCase() === "authorization" ? authorization : undefined; },
  } as Request;
  handler(request, response as unknown as Response, () => { nextCalls += 1; });
  return { response, nextCalls };
}

function resolveLocalReference(document: any, reference: string): unknown {
  assert.ok(reference.startsWith("#/"), `Expected a local OpenAPI reference: ${reference}`);
  return reference.slice(2).split("/").reduce((value: any, segment) => value?.[segment], document);
}

test("OpenAPI is valid JSON 3.1 and every local reference resolves", async () => {
  const source = await readFile(resolve(process.cwd(), "docs/openapi.json"), "utf8");
  const document = JSON.parse(source);
  assert.equal(document.openapi, "3.1.0");

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) {
        assert.notEqual(resolveLocalReference(document, child), undefined, `Unresolved reference: ${child}`);
      } else {
        visit(child);
      }
    }
  };
  visit(document);

  for (const [path, pathItem] of Object.entries<any>(document.paths)) {
    for (const [method, operation] of Object.entries<any>(pathItem)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      assert.ok(operation.operationId, `${method.toUpperCase()} ${path} needs an operationId`);
      assert.ok(operation.responses && Object.keys(operation.responses).length > 0,
        `${method.toUpperCase()} ${path} needs responses`);
    }
  }
});

test("OpenAPI documents the current mounted module paths and key authorization boundaries", async () => {
  const document = JSON.parse(await readFile(resolve(process.cwd(), "docs/openapi.json"), "utf8"));
  const paths = document.paths;
  const requiredPaths = [
    "/", "/api/v1/health", "/api/v1/health/ready", "/api/v1/health/metrics",
    "/api/v1/docs", "/api/v1/docs/openapi.json", "/api/v1/docs/swagger-initializer.js",
    "/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/auth/refresh", "/api/v1/auth/logout", "/api/v1/auth/me",
    "/api/v1/auth/verify-email", "/api/v1/auth/resend-verification", "/api/v1/auth/password-reset/request", "/api/v1/auth/password-reset/confirm",
    "/api/v1/deliveries/track/{trackingCode}", "/api/v1/deliveries", "/api/v1/deliveries/my",
    "/api/v1/deliveries/assigned", "/api/v1/deliveries/statistics", "/api/v1/deliveries/{id}/assign",
    "/api/v1/deliveries/{id}", "/api/v1/deliveries/{id}/status", "/api/v1/deliveries/{id}/location", "/api/v1/deliveries/{id}/location/history",
    "/api/v1/drivers", "/api/v1/drivers/{id}", "/api/v1/drivers/{id}/status", "/api/v1/drivers/{id}/statistics",
    "/api/v1/customers", "/api/v1/customers/{id}", "/api/v1/customers/{id}/status", "/api/v1/customers/{id}/statistics",
    "/api/v1/notifications", "/api/v1/notifications/unread-count", "/api/v1/notifications/read-all", "/api/v1/notifications/{id}/read",
    "/api/v1/audit-logs",
  ];
  for (const path of requiredPaths) assert.ok(paths[path], `Missing documented route ${path}`);
  assert.deepEqual(Object.keys(paths).sort(), requiredPaths.sort(), "OpenAPI paths must match the current mounted API surface");

  assert.deepEqual(paths["/api/v1/deliveries/track/{trackingCode}"].get.security, []);
  assert.deepEqual(paths["/api/v1/auth/me"].get.security ?? document.security, [{ BearerAuth: [] }]);
  assert.deepEqual(paths["/api/v1/health/metrics"].get.security, [{ MetricsBearerAuth: [] }]);
  assert.ok(paths["/api/v1/deliveries/{id}/status"].patch["x-required-roles"]);
  assert.deepEqual(paths["/api/v1/audit-logs"].get["x-required-roles"], ["ADMIN", "SUPER_ADMIN"]);
});

test("authorization matrix documents each current role and ownership boundary", async () => {
  const matrix = await readFile(resolve(process.cwd(), "docs/authorization-matrix.md"), "utf8");
  const openapi = JSON.parse(await readFile(resolve(process.cwd(), "docs/openapi.json"), "utf8"));
  for (const role of ["CUSTOMER", "DRIVER", "DISPATCHER", "ADMIN", "SUPER_ADMIN"]) {
    assert.match(matrix, new RegExp(role));
  }
  assert.match(matrix, /foreign or nonexistent delivery returns 404/i);
  assert.match(matrix, /notifications are always queried and updated with both notification ID and the authenticated user's ID/i);
  assert.match(matrix, /JWT role claims are not authorization inputs/i);
  assert.match(openapi.paths["/api/v1/deliveries/{id}"].get.description, /ownership-scoped in the database/i);
  assert.match(openapi.paths["/api/v1/deliveries/{id}/location"].get.description, /out-of-scope or unknown delivery returns 404/i);
});

test("Swagger access is disabled when configured off and production access needs the configured Basic token", () => {
  const disabled = invokeAccessHandler(createDocsAccessHandler({ enabled: false, environment: "development" }));
  assert.equal(disabled.response.statusCode, 404);
  assert.equal(disabled.nextCalls, 0);

  const production = createDocsAccessHandler({ enabled: true, environment: "production", accessToken: "t".repeat(40) });
  const denied = invokeAccessHandler(production, `Basic ${Buffer.from("docs:wrong").toString("base64")}`);
  assert.equal(denied.response.statusCode, 401);
  assert.equal(denied.response.headers["WWW-Authenticate"], 'Basic realm="FleetFlow API docs", charset="UTF-8"');
  const allowed = invokeAccessHandler(production, `Basic ${Buffer.from(`docs:${"t".repeat(40)}`).toString("base64")}`);
  assert.equal(allowed.nextCalls, 1);

  const development = invokeAccessHandler(createDocsAccessHandler({ enabled: true, environment: "development" }));
  assert.equal(development.nextCalls, 1);
});

test("metrics access is hidden without a token and rejects invalid bearer credentials", () => {
  const hidden = invokeAccessHandler(createMetricsAccessHandler());
  assert.equal(hidden.response.statusCode, 404);
  const denied = invokeAccessHandler(createMetricsAccessHandler("m".repeat(40)), "Bearer wrong");
  assert.equal(denied.response.statusCode, 401);
  const allowed = invokeAccessHandler(createMetricsAccessHandler("m".repeat(40)), `Bearer ${"m".repeat(40)}`);
  assert.equal(allowed.nextCalls, 1);
});

test("metrics track counts, errors, status distribution, disjoint duration buckets, and dependencies", () => {
  const recorder = createMetricsRecorder(1_000);
  recorder.recordRequest(201, 25);
  recorder.recordRequest(503, 1_500);
  recorder.setDependencyAvailability("database", true);
  recorder.setDependencyAvailability("redis", false);
  const snapshot = recorder.snapshot();

  assert.equal(snapshot.requests.total, 2);
  assert.equal(snapshot.requests.errors, 1);
  assert.deepEqual(snapshot.requests.byStatus, { "201": 1, "503": 1 });
  assert.equal(snapshot.durationMs.count, 2);
  assert.equal(snapshot.durationMs.sum, 1_525);
  assert.equal(snapshot.durationMs.max, 1_500);
  assert.equal(snapshot.durationMs.buckets["50"], 1);
  assert.equal(snapshot.durationMs.buckets["2500"], 1);
  assert.equal(snapshot.dependencies.database.status, "up");
  assert.equal(snapshot.dependencies.redis.status, "down");
  assert.equal(snapshot.dependencies.redis.checkedAt === null, false);
});

test("request context adds correlation IDs to service logs without logging sensitive values", async () => {
  const lines: string[] = [];
  const logger = createLogger("production", { log: (line) => lines.push(line) });
  await new Promise<void>((resolve) => {
    runWithRequestContext("correlation-123", () => {
      setImmediate(() => {
        logger("info", "delivery_updated", { deliveryId: "delivery-1" });
        resolve();
      });
    });
  });
  const record = JSON.parse(lines[0]);
  assert.equal(record.requestId, "correlation-123");
  assert.equal(record.event, "delivery_updated");
  assert.doesNotMatch(lines.join(" "), /password|refreshToken|webhook|phone|recipient/i);
});

test("logger redacts secrets, credentials, personal data, and precise location fields", () => {
  const lines: string[] = [];
  const logger = createLogger("production", { log: (line) => lines.push(line) });
  logger("info", "sensitive_fields_check", {
    password: "password-marker",
    accessToken: "access-marker",
    refreshToken: "refresh-marker",
    authorization: "authorization-marker",
    webhookUrl: "webhook-marker",
    email: "email-marker",
    firstName: "name-marker",
    phone: "phone-marker",
    deliveryAddress: "address-marker",
    latitude: 41.7,
    longitude: 44.8,
    requestId: "safe-request-id",
  });

  const record = JSON.parse(lines[0]);
  for (const field of [
    "password", "accessToken", "refreshToken", "authorization", "webhookUrl", "email",
    "firstName", "phone", "deliveryAddress", "latitude", "longitude",
  ]) assert.equal(record[field], "[REDACTED]");
  assert.equal(record.requestId, "safe-request-id");
  assert.doesNotMatch(lines[0], /password-marker|access-marker|refresh-marker|webhook-marker|email-marker|name-marker|phone-marker|address-marker/);
});
