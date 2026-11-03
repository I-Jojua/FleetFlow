import dotenv from "dotenv";
import { z } from "zod";
import { logger } from "../utils/logger.js";

dotenv.config();

const DEFAULT_DATABASE_URL =
  "postgresql://fleetflow:fleetflow_dev_password@localhost:5432/fleetflow";
const DEFAULT_ACCESS_SECRET = "development_access_secret_change_this";
const DEFAULT_REFRESH_SECRET = "development_refresh_secret_change_this";

const allowedOriginsSchema = z.string()
  .default("http://localhost:5173")
  .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean))
  .refine((origins) => origins.length > 0 && origins.every((origin) => {
    if (origin === "*") return false;
    try {
      const parsed = new URL(origin);
      return ["http:", "https:"].includes(parsed.protocol) && parsed.origin === origin;
    } catch {
      return false;
    }
  }), "Must be a comma-separated list of explicit HTTP(S) origins.");

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  JOB_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  JOB_BACKOFF_DELAY_MS: z.coerce.number().int().min(100).max(300_000).default(1_000),
  JOB_COMPLETED_RETENTION_COUNT: z.coerce.number().int().min(0).max(100_000).default(1_000),
  JOB_FAILED_RETENTION_COUNT: z.coerce.number().int().min(1).max(100_000).default(5_000),
  IDEMPOTENCY_KEY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  OUTBOX_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
  OUTBOX_BACKOFF_BASE_MS: z.coerce.number().int().min(100).max(300_000).default(1_000),
  EMAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  EMAIL_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().default("no-reply@example.test"),
  APP_BASE_URL: z.string().url().default("http://localhost:5173"),
  EMAIL_TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().int().min(1).max(10_080).default(1_440),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(1).max(1_440).default(30),
  CORS_ALLOWED_ORIGINS: allowedOriginsSchema,
  API_DOCS_ENABLED: z.enum(["auto", "true", "false"]).default("auto"),
  API_DOCS_ACCESS_TOKEN: z.string().min(32).optional(),
  METRICS_ACCESS_TOKEN: z.string().min(32).optional(),

  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol),
      "Must be a PostgreSQL connection URL.",
    )
    .default(DEFAULT_DATABASE_URL),

  REDIS_URL: z
    .string()
    .url()
    .refine(
      (value) => ["redis:", "rediss:"].includes(new URL(value).protocol),
      "Must be a Redis connection URL.",
    )
    .default("redis://localhost:6379"),

  SLACK_WEBHOOK_URL: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === "https:", "Must use HTTPS.")
    .optional(),

  JWT_ACCESS_SECRET: z.string().min(32).default(DEFAULT_ACCESS_SECRET),
  JWT_REFRESH_SECRET: z.string().min(32).default(DEFAULT_REFRESH_SECRET),
});

export type AppEnvironment = Omit<z.infer<typeof envSchema>, "API_DOCS_ENABLED"> & {
  API_DOCS_ENABLED: boolean;
};

/** Parse configuration without logging values or exposing secret inputs. */
export function validateEnvironment(
  source: Record<string, string | undefined>,
): AppEnvironment {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const invalidFields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "configuration"))),
    ];
    throw new Error(`Invalid environment variables: ${invalidFields.join(", ")}`);
  }

  const values = parsed.data;
  const invalidProductionFields: string[] = [];

  if (values.NODE_ENV === "production") {
    if (!source.DATABASE_URL || values.DATABASE_URL === DEFAULT_DATABASE_URL) {
      invalidProductionFields.push("DATABASE_URL");
    }

    if (
      !source.JWT_ACCESS_SECRET ||
      values.JWT_ACCESS_SECRET === DEFAULT_ACCESS_SECRET
    ) {
      invalidProductionFields.push("JWT_ACCESS_SECRET");
    }

    if (
      !source.JWT_REFRESH_SECRET ||
      values.JWT_REFRESH_SECRET === DEFAULT_REFRESH_SECRET
    ) {
      invalidProductionFields.push("JWT_REFRESH_SECRET");
    }

    if (values.JWT_ACCESS_SECRET === values.JWT_REFRESH_SECRET) {
      invalidProductionFields.push("JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET");
    }

    if (!source.REDIS_URL) invalidProductionFields.push("REDIS_URL");
    if (!source.CORS_ALLOWED_ORIGINS) invalidProductionFields.push("CORS_ALLOWED_ORIGINS");
    if (values.API_DOCS_ENABLED === "true" && !source.API_DOCS_ACCESS_TOKEN) {
      invalidProductionFields.push("API_DOCS_ACCESS_TOKEN");
    }
    if (values.EMAIL_PROVIDER !== "resend") invalidProductionFields.push("EMAIL_PROVIDER");
    if (!source.EMAIL_API_KEY) invalidProductionFields.push("EMAIL_API_KEY");
    if (!source.EMAIL_FROM) invalidProductionFields.push("EMAIL_FROM");
    if (!source.APP_BASE_URL) invalidProductionFields.push("APP_BASE_URL");
    if (!source.EMAIL_TOKEN_ENCRYPTION_KEY) invalidProductionFields.push("EMAIL_TOKEN_ENCRYPTION_KEY");
    if (new URL(values.APP_BASE_URL).protocol !== "https:") {
      invalidProductionFields.push("APP_BASE_URL");
    }
  }

  if (invalidProductionFields.length > 0) {
    throw new Error(
      `Invalid production environment variables: ${[...new Set(invalidProductionFields)].join(", ")}`,
    );
  }

  return {
    ...values,
    API_DOCS_ENABLED:
      values.API_DOCS_ENABLED === "auto"
        ? values.NODE_ENV !== "production"
        : values.API_DOCS_ENABLED === "true",
  };
}

function loadEnvironment(): AppEnvironment {
  try {
    return validateEnvironment(process.env);
  } catch (error) {
    logger.error("environment_configuration_invalid", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    process.exit(1);
  }
}

export const env = loadEnvironment();
