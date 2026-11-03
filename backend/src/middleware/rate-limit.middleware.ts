import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { env } from "../config/env.js";
import { ensureRedisConnected, redis } from "../config/redis.js";
import { logger } from "../utils/logger.js";
import { metrics } from "../observability/metrics.js";

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  key?: string;
}

export interface RateLimitCounter {
  count: number;
  ttlMs: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<RateLimitCounter>;
}

export interface RateLimiterDependencies {
  store?: RateLimitStore;
  environment?: string;
  now?: () => number;
  onStoreFailure?: () => void;
}

const INCREMENT_WITH_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

type RedisEvalClient = {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
};

export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly client: RedisEvalClient,
    private readonly namespace = "fleetflow:rate-limit",
    private readonly ensureReady?: () => Promise<void>,
  ) {}

  async increment(key: string, windowMs: number): Promise<RateLimitCounter> {
    await this.ensureReady?.();
    const response = await this.client.eval(
      INCREMENT_WITH_TTL_SCRIPT,
      1,
      `${this.namespace}:${key}`,
      String(windowMs),
    );

    if (!Array.isArray(response) || response.length < 2) {
      throw new Error("Invalid Redis rate-limit response.");
    }

    const count = Number(response[0]);
    const ttlMs = Number(response[1]);
    if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) {
      throw new Error("Invalid Redis rate-limit response.");
    }

    return { count, ttlMs: Math.max(0, ttlMs) };
  }
}

class LocalRateLimitStore implements RateLimitStore {
  private readonly clients = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number) {}

  async increment(key: string, windowMs: number): Promise<RateLimitCounter> {
    const currentTime = this.now();
    let window = this.clients.get(key);
    if (!window || window.resetAt <= currentTime) {
      window = { count: 0, resetAt: currentTime + windowMs };
    }
    window.count += 1;
    this.clients.set(key, window);

    if (this.clients.size > 50_000) {
      for (const [clientKey, entry] of this.clients) {
        if (entry.resetAt <= currentTime) this.clients.delete(clientKey);
      }
    }

    return { count: window.count, ttlMs: Math.max(0, window.resetAt - currentTime) };
  }
}

export function createRedisRateLimitStore(
  client: RedisEvalClient,
  namespace?: string,
  ensureReady?: () => Promise<void>,
): RateLimitStore {
  return new RedisRateLimitStore(client, namespace, ensureReady);
}

function sendRateLimitResponse(
  res: Parameters<RequestHandler>[1],
  retryAfterSeconds: number,
) {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    success: false,
    code: "RATE_LIMITED",
    message: "Too many requests. Please try again later.",
  });
}

function getClientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function createRateLimiter(
  { windowMs, maxRequests, key = `${windowMs}:${maxRequests}` }: RateLimitOptions,
  dependencies: RateLimiterDependencies = {},
): RequestHandler {
  if (!Number.isFinite(windowMs) || windowMs < 1) {
    throw new RangeError("Rate-limit window must be a positive number.");
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 1) {
    throw new RangeError("Rate-limit maximum must be a positive integer.");
  }

  const now = dependencies.now ?? Date.now;
  const environment = dependencies.environment ?? env.NODE_ENV;
  const store = dependencies.store ?? createRedisRateLimitStore(
    redis,
    undefined,
    ensureRedisConnected,
  );
  const localFallback = new LocalRateLimitStore(now);

  return async (req, res, next) => {
    const rawKey = `${key}:${getClientKey(req)}`;
    const clientKey = createHash("sha256").update(rawKey).digest("hex");
    let counter: RateLimitCounter;

    try {
      counter = await store.increment(clientKey, windowMs);
      if (store instanceof RedisRateLimitStore) {
        metrics.setDependencyAvailability("redis", true);
      }
    } catch {
      if (store instanceof RedisRateLimitStore) {
        metrics.setDependencyAvailability("redis", false);
      }
      dependencies.onStoreFailure?.();
      logger.warn("rate_limit_store_unavailable", { policy: key });

      if (environment === "production") {
        res.status(503).json({
          success: false,
          code: "RATE_LIMIT_STORE_UNAVAILABLE",
          message: "Request protection is temporarily unavailable.",
        });
        return;
      }

      counter = await localFallback.increment(clientKey, windowMs);
    }

    const ttlMs = Math.max(0, counter.ttlMs);
    const resetSeconds = Math.max(0, Math.ceil(ttlMs / 1000));
    res.setHeader("RateLimit-Policy", `${maxRequests};w=${Math.ceil(windowMs / 1000)}`);
    res.setHeader("RateLimit-Limit", String(maxRequests));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (counter.count > maxRequests) {
      sendRateLimitResponse(res, Math.max(1, resetSeconds));
      return;
    }

    res.setHeader("RateLimit-Remaining", String(Math.max(0, maxRequests - counter.count)));
    next();
  };
}

export const RATE_LIMIT_POLICIES = {
  login: { key: "login", windowMs: 15 * 60 * 1000, maxRequests: 10 },
  register: { key: "register", windowMs: 60 * 60 * 1000, maxRequests: 5 },
  refresh: { key: "refresh", windowMs: 15 * 60 * 1000, maxRequests: 30 },
  verifyEmail: { key: "verify-email", windowMs: 15 * 60 * 1000, maxRequests: 10 },
  resendVerification: { key: "resend-verification", windowMs: 60 * 60 * 1000, maxRequests: 5 },
  passwordResetRequest: { key: "password-reset-request", windowMs: 60 * 60 * 1000, maxRequests: 5 },
  passwordResetConfirm: { key: "password-reset-confirm", windowMs: 15 * 60 * 1000, maxRequests: 10 },
  publicTracking: { key: "public-tracking", windowMs: 15 * 60 * 1000, maxRequests: 60 },
  auditRead: { key: "audit-read", windowMs: 60 * 1000, maxRequests: 60 },
  driverLocationUpdate: { key: "driver-location-update", windowMs: 60 * 1000, maxRequests: 60 },
  locationRead: { key: "location-read", windowMs: 60 * 1000, maxRequests: 120 },
  activeDriverLocations: { key: "active-driver-locations", windowMs: 60 * 1000, maxRequests: 30 },
  realtimeTicket: { key: "realtime-ticket", windowMs: 60 * 1000, maxRequests: 20 },
  dispatchRecommendations: { key: "dispatch-recommendations", windowMs: 60 * 1000, maxRequests: 30 },
  workforceRead: { key: "workforce-read", windowMs: 60 * 1000, maxRequests: 120 },
  workforceWrite: { key: "workforce-write", windowMs: 60 * 1000, maxRequests: 30 },
} as const;

export const authRateLimiters = {
  login: createRateLimiter(RATE_LIMIT_POLICIES.login),
  register: createRateLimiter(RATE_LIMIT_POLICIES.register),
  refresh: createRateLimiter(RATE_LIMIT_POLICIES.refresh),
  verifyEmail: createRateLimiter(RATE_LIMIT_POLICIES.verifyEmail),
  resendVerification: createRateLimiter(RATE_LIMIT_POLICIES.resendVerification),
  passwordResetRequest: createRateLimiter(RATE_LIMIT_POLICIES.passwordResetRequest),
  passwordResetConfirm: createRateLimiter(RATE_LIMIT_POLICIES.passwordResetConfirm),
};

export const publicTrackingRateLimiter = createRateLimiter(
  RATE_LIMIT_POLICIES.publicTracking,
);

export const auditReadRateLimiter = createRateLimiter(RATE_LIMIT_POLICIES.auditRead);
export const driverLocationUpdateRateLimiter = createRateLimiter(RATE_LIMIT_POLICIES.driverLocationUpdate);
export const locationReadRateLimiter = createRateLimiter(RATE_LIMIT_POLICIES.locationRead);
export const activeDriverLocationsRateLimiter = createRateLimiter(RATE_LIMIT_POLICIES.activeDriverLocations);
export const realtimeTicketRateLimiter = createRateLimiter(RATE_LIMIT_POLICIES.realtimeTicket);
export const dispatchRecommendationsRateLimiter = createRateLimiter(RATE_LIMIT_POLICIES.dispatchRecommendations);
export const workforceReadRateLimiter = createRateLimiter(RATE_LIMIT_POLICIES.workforceRead);
export const workforceWriteRateLimiter = createRateLimiter(RATE_LIMIT_POLICIES.workforceWrite);
