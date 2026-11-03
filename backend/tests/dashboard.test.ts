import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { Express } from "express";

test("root serves the dashboard while health, Swagger, and unknown API routes keep their contracts", async (context) => {
  process.env.NODE_ENV = "test";
  process.env.API_DOCS_ENABLED = "true";
  const appModule = await import("../src/app.js");
  const server = createServer(appModule.default as unknown as Express);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const root = await fetch(`${baseUrl}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type") ?? "", /text\/html/);
  const html = await root.text();
  assert.match(html, /FleetFlow/);
  assert.match(html, /Delivery flow/);

  for (const [asset, contentType] of [["styles.css", /text\/css/], ["app.js", /javascript/]] as const) {
    const response = await fetch(`${baseUrl}/dashboard/${asset}`);
    assert.equal(response.status, 200, `${asset} should be served`);
    assert.match(response.headers.get("content-type") ?? "", contentType);
    const source = await response.text();
    if (asset === "styles.css") {
      assert.match(source, /@media\(max-width:800px\)/, "dashboard should adapt for tablet widths");
      assert.match(source, /@media\(max-width:560px\)/, "dashboard should adapt for mobile widths");
    }
    if (asset === "app.js") assert.doesNotMatch(source, /localStorage|sessionStorage/, "tokens must not be persisted in web storage");
  }

  const health = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { data: { status: string } }).data.status, "healthy");

  const swagger = await fetch(`${baseUrl}/api/v1/docs/`);
  assert.equal(swagger.status, 200);
  assert.match(await swagger.text(), /swagger-ui/);
  const openApi = await fetch(`${baseUrl}/api/v1/docs/openapi.json`);
  assert.equal(openApi.status, 200);
  assert.equal((await openApi.json() as { openapi: string }).openapi, "3.1.0");

  const missingApi = await fetch(`${baseUrl}/api/v1/not-a-real-route`);
  assert.equal(missingApi.status, 404);
  assert.deepEqual(await missingApi.json(), {
    success: false,
    code: "NOT_FOUND",
    message: "Route not found.",
  });
});
