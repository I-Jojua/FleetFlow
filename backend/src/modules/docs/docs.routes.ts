import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Router, type RequestHandler } from "express";
import { env } from "../../config/env.js";

const router = Router();

function readOpenApiDocument() {
  return JSON.parse(readFileSync(resolve(__dirname, "../../../docs/openapi.json"), "utf8"));
}

function sendDisabled(res: Parameters<RequestHandler>[1]) {
  res.status(404).json({
    success: false,
    code: "NOT_FOUND",
    message: "Route not found.",
  });
}

function constantTimeMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createDocsAccessHandler(
  options: { enabled: boolean; environment: string; accessToken?: string },
): RequestHandler {
  return (req, res, next) => {
    if (!options.enabled) {
      sendDisabled(res);
      return;
    }

    if (options.environment !== "production") {
      next();
      return;
    }

    const authorization = req.get("authorization") ?? "";
    const basic = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(authorization);
    let suppliedToken = "";
    if (basic) {
      const credentials = Buffer.from(basic[1], "base64").toString("utf8");
      const separator = credentials.indexOf(":");
      if (separator >= 0 && credentials.slice(0, separator) === "docs") {
        suppliedToken = credentials.slice(separator + 1);
      }
    }

    if (!options.accessToken || !constantTimeMatches(suppliedToken, options.accessToken)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="FleetFlow API docs", charset="UTF-8"');
      res.status(401).json({
        success: false,
        code: "UNAUTHORIZED",
        message: "Documentation authentication required.",
      });
      return;
    }

    next();
  };
}

const docsAccess = createDocsAccessHandler({
  enabled: env.API_DOCS_ENABLED,
  environment: env.NODE_ENV,
  accessToken: env.API_DOCS_ACCESS_TOKEN,
});

router.get("/", docsAccess, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data:; connect-src 'self'; font-src 'self' https://unpkg.com data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FleetFlow API documentation</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
    <script src="/api/v1/docs/swagger-initializer.js"></script>
  </body>
</html>`);
});

router.get("/openapi.json", docsAccess, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(readOpenApiDocument());
});

router.get("/swagger-initializer.js", docsAccess, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("application/javascript").send(`window.onload = function () {
  window.ui = SwaggerUIBundle({
    url: "/api/v1/docs/openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: "StandaloneLayout",
    withCredentials: true
  });
};`);
});

export default router;
