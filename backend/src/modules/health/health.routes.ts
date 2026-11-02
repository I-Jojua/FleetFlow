
import { Router, Request, Response, type RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { getReadiness } from "./health.service.js";
import { metrics } from "../../observability/metrics.js";
import { env } from "../../config/env.js";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "FleetFlow API is running!",
    data: {
      status: "healthy",
      service: "FleetFlow Backend",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    },
  });
});

export function createReadinessHandler(
  readinessCheck: typeof getReadiness = getReadiness,
): RequestHandler {
  return async (_req, res) => {
    const result = await readinessCheck();
    res.status(result.ready ? 200 : 503).json({
      success: result.ready,
      ...(result.ready ? {} : { code: "NOT_READY" }),
      message: result.ready ? "FleetFlow API is ready." : "A required dependency is unavailable.",
      data: {
        status: result.ready ? "ready" : "not_ready",
        dependencies: result.dependencies,
      },
    });
  };
}

router.get("/ready", createReadinessHandler());

export function createMetricsAccessHandler(accessToken?: string): RequestHandler {
  return (req, res, next) => {
    if (!accessToken) {
      res.status(404).json({
        success: false,
        code: "NOT_FOUND",
        message: "Route not found.",
      });
      return;
    }

    const authorization = req.get("authorization") ?? "";
    const bearer = /^Bearer ([^\s]+)$/.exec(authorization);
    const provided = Buffer.from(bearer?.[1] ?? "");
    const expected = Buffer.from(accessToken);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({
        success: false,
        code: "UNAUTHORIZED",
        message: "Metrics authentication required.",
      });
      return;
    }

    next();
  };
}

router.get("/metrics", createMetricsAccessHandler(env.METRICS_ACCESS_TOKEN), (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ success: true, data: metrics.snapshot() });
});

export default router;
