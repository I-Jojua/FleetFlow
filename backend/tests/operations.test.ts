import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { createLogger } from "../src/utils/logger.js";
import { requestLogger } from "../src/middleware/request-logger.middleware.js";
import { createReadinessHandler } from "../src/modules/health/health.routes.js";
import { getReadiness } from "../src/modules/health/health.service.js";
import { createGracefulShutdown } from "../src/server/graceful-shutdown.js";

function readinessResponse() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    get statusCode() { return statusCode; },
    get body() { return body; },
    status(code: number) { statusCode = code; return response; },
    json(value: unknown) { body = value; return response; },
  };
  return response;
}

test("readiness reports HTTP 200 only when PostgreSQL and Redis are healthy", async () => {
  const healthy = await getReadiness({
    database: async () => 1,
    redis: async () => "PONG",
  });
  assert.deepEqual(healthy, {
    ready: true,
    dependencies: { database: true, redis: true },
  });

  const healthyResponse = readinessResponse();
  const healthyHandler = createReadinessHandler(async () => healthy);
  await healthyHandler({} as Request, healthyResponse as unknown as Response, () => undefined);
  assert.equal(healthyResponse.statusCode, 200);

  const response = readinessResponse();
  const handler = createReadinessHandler(async () => ({
    ready: false,
    dependencies: { database: true, redis: false },
  }));
  await handler({} as Request, response as unknown as Response, () => undefined);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {
    success: false,
    code: "NOT_READY",
    message: "A required dependency is unavailable.",
    data: {
      status: "not_ready",
      dependencies: { database: true, redis: false },
    },
  });
  assert.equal(JSON.stringify(response.body).includes("redis://"), false);
});

test("readiness treats synchronous and asynchronous dependency failures as unhealthy", async () => {
  const result = await getReadiness({
    database: () => { throw new Error("private database connection details"); },
    redis: async () => { throw new Error("private redis connection details"); },
  });
  assert.deepEqual(result, {
    ready: false,
    dependencies: { database: false, redis: false },
  });
});

test("production logger emits structured JSON fields without arbitrary error text", () => {
  const lines: string[] = [];
  const log = createLogger("production", { log: (line) => lines.push(line) });
  log("error", "api_request_failed", { requestId: "request-123", statusCode: 500 });

  const record = JSON.parse(lines[0]);
  assert.equal(record.level, "error");
  assert.equal(record.event, "api_request_failed");
  assert.equal(record.requestId, "request-123");
  assert.equal("stack" in record, false);
  assert.equal(lines.join(" ").includes("password"), false);
});

test("request logging returns an ID and records route timing without query secrets", (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (message: string) => logs.push(message));
  let finish: (() => void) | undefined;
  const headers: Record<string, string> = {};
  let nextCalls = 0;
  const req = {
    method: "GET",
    baseUrl: "/api/v1/track",
    route: { path: "/:trackingCode" },
    originalUrl: "/api/v1/track/FF-SECRET?access_token=private-marker&refresh_token=refresh-marker&password=password-marker",
  } as Request;
  const res = {
    locals: {},
    statusCode: 200,
    setHeader(name: string, value: string) { headers[name] = value; return res; },
    once(_event: string, callback: () => void) { finish = callback; return res; },
  } as unknown as Response;

  requestLogger(req, res, () => { nextCalls += 1; });
  finish?.();

  assert.equal(nextCalls, 1);
  assert.match(headers["X-Request-Id"], /^[0-9a-f-]{36}$/i);
  assert.equal((res.locals as Record<string, unknown>).requestId, headers["X-Request-Id"]);
  assert.match(logs[0], /http_request_completed/);
  assert.match(logs[0], /durationMs/);
  assert.doesNotMatch(logs.join(" "), /private-marker|FF-SECRET|access_token|refresh-marker|password-marker/);
});

test("graceful shutdown waits for server close and runs only once", async () => {
  let closeCalls = 0;
  let dbCloseCalls = 0;
  let redisCloseCalls = 0;
  let exitCode: number | undefined;
  const server = {
    close(callback?: (error?: Error) => void) { closeCalls += 1; callback?.(); },
    closeAllConnections() { throw new Error("must not force close"); },
  } as any;
  const shutdown = createGracefulShutdown({
    server,
    timeoutMs: 1_000,
    closeDatabase: async () => { dbCloseCalls += 1; },
    closeRedis: async () => { redisCloseCalls += 1; },
    onExit: (code) => { exitCode = code; },
    log: { info() {}, warn() {}, error() {} },
  });

  const first = shutdown("SIGTERM");
  const duplicate = shutdown("SIGINT");
  assert.equal(first, duplicate);
  await Promise.all([first, duplicate]);

  assert.equal(closeCalls, 1);
  assert.equal(dbCloseCalls, 1);
  assert.equal(redisCloseCalls, 1);
  assert.equal(exitCode, 0);
});

test("graceful shutdown force-closes HTTP connections after the configured timeout", async () => {
  let forcedCloseCalls = 0;
  let exitCode: number | undefined;
  const shutdown = createGracefulShutdown({
    server: {
      close() {},
      closeAllConnections() { forcedCloseCalls += 1; },
    } as any,
    timeoutMs: 10,
    closeDatabase: async () => undefined,
    closeRedis: async () => undefined,
    onExit: (code) => { exitCode = code; },
    log: { info() {}, warn() {}, error() {} },
  });

  await shutdown("SIGTERM");
  assert.equal(forcedCloseCalls, 1);
  assert.equal(exitCode, 1);
});
