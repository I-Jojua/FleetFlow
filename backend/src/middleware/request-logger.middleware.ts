import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { RequestHandler } from "express";
import { logger } from "../utils/logger.js";
import { metrics } from "../observability/metrics.js";
import { runWithRequestContext } from "../observability/request-context.js";

export const requestLogger: RequestHandler = (req, res, next) => {
  const requestId = randomUUID();
  const startedAt = performance.now();

  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.once("finish", () => {
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    metrics.recordRequest(res.statusCode, durationMs);
    const routePath = req.route?.path;
    const route = typeof routePath === "string"
      ? `${req.baseUrl}${routePath}`
      : "unmatched";

    logger.info("http_request_completed", {
      requestId,
      method: req.method,
      route,
      statusCode: res.statusCode,
      durationMs,
    });
  });

  const ipAddress = isIP(req.ip ?? "") ? req.ip : undefined;
  runWithRequestContext(requestId, next, ipAddress);
};
