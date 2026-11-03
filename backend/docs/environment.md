# Environment variables

The application parses configuration in `src/config/env.ts`. It does not log environment values. Keep actual `.env` files, tokens, passwords, database URLs, and webhook URLs out of source control.

| Variable | Default / format | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | Allowed values: `development`, `test`, `production`. |
| `PORT` | `5000` | HTTP port, integer 1–65535. |
| `DATABASE_URL` | Local PostgreSQL development default | PostgreSQL URL. Must be explicitly set in production. |
| `REDIS_URL` | `redis://localhost:6379` | Redis/Rediss URL. Must be explicitly set in production; production rate limits fail closed if Redis is unavailable. |
| `JWT_ACCESS_SECRET` | Development-only default | At least 32 characters. Must be explicit and distinct from the refresh secret in production. |
| `JWT_REFRESH_SECRET` | Development-only default | At least 32 characters. Must be explicit and distinct from the access secret in production. |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated explicit HTTP(S) origins. No wildcard; required explicitly in production. Do not include URL paths or trailing slashes. |
| `TRUST_PROXY_HOPS` | `0` | Number of trusted reverse-proxy hops. Set only for the actual deployment topology. |
| `GRACEFUL_SHUTDOWN_TIMEOUT_MS` | `10000` | Wait for in-flight HTTP work for 100–120000 ms before force-closing connections. |
| `JOB_WORKER_CONCURRENCY` | `5` | Jobs a worker process can process in parallel, integer 1–100. |
| `JOB_MAX_ATTEMPTS` | `3` | Total attempts per job, integer 1–20. Retries use exponential backoff. |
| `JOB_BACKOFF_DELAY_MS` | `1000` | Initial exponential retry delay in milliseconds, integer 100–300000. |
| `JOB_COMPLETED_RETENTION_COUNT` | `1000` | Maximum number of completed jobs retained by BullMQ. |
| `JOB_FAILED_RETENTION_COUNT` | `5000` | Maximum number of failed jobs retained for inspection or retry. |
| `IDEMPOTENCY_KEY_TTL_HOURS` | `24` | How long a successful key replay remains valid, integer 1–168 hours. Expired records for a key are removed when that key is used again. |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | Delay between database outbox scans, integer 100–60000 ms. |
| `OUTBOX_LOCK_TIMEOUT_MS` | `30000` | A processing lease older than this is reclaimed after worker failure, integer 1000–600000 ms. |
| `OUTBOX_BATCH_SIZE` | `25` | Maximum events claimed per dispatcher pass, integer 1–500. |
| `OUTBOX_MAX_ATTEMPTS` | `8` | Maximum enqueue attempts before an outbox event is marked permanently failed. |
| `OUTBOX_BACKOFF_BASE_MS` | `1000` | Initial delay for exponential outbox retries, integer 100–300000 ms. |
| `GPS_MAX_AGE_SECONDS` | `300` | Reject submitted GPS timestamps older than this limit, integer 30–86400 seconds. |
| `GPS_MAX_FUTURE_SKEW_SECONDS` | `30` | Maximum accepted device clock skew into the future, integer 0–300 seconds. |
| `GPS_STALE_AFTER_SECONDS` | `120` | A last location older than this is marked stale in API results, integer 10–86400 seconds. |
| `DISPATCH_MAX_ACTIVE_DELIVERIES` | `5` | Maximum concurrent `ASSIGNED`, `PICKED_UP`, or `IN_TRANSIT` deliveries for a driver to be recommended or newly assigned, integer 1–100. |
| `DISPATCH_DISTANCE_WEIGHT` | `60` | Integer score weight 0–100. Together with workload, freshness, and vehicle-fit weights, must sum to 100. |
| `DISPATCH_WORKLOAD_WEIGHT` | `25` | Integer score weight 0–100 for active delivery load. |
| `DISPATCH_FRESHNESS_WEIGHT` | `15` | Integer score weight 0–100 for GPS freshness. |
| `DISPATCH_VEHICLE_FIT_WEIGHT` | `0` | Integer score weight 0–100 for capacity utilization fit. Default 0 preserves the P6.1 ranking; all four dispatch weights must sum to 100. |
| `DISPATCH_DISTANCE_NORMALIZATION_KM` | `100` | Distance at which the straight-line distance component reaches zero, positive number up to 1000 km. This is score normalization, not an eligibility radius or road distance. |
| `GPS_LOCATION_RETENTION_DAYS` | `90` | Location history age after which the worker removes GPS rows, integer 1–3650 days. |
| `REALTIME_MAX_CONNECTIONS` | `1000` | Maximum established plus pending WebSocket connections per API process, integer 1–100000. Excess upgrades receive HTTP 503. |
| `REALTIME_MAX_CONNECTIONS_PER_IP` | `50` | Maximum established plus pending WebSocket connections per direct peer IP per process, integer 1–10000. Excess upgrades receive HTTP 429. |
| `REALTIME_MAX_BUFFERED_BYTES` | `1048576` | Maximum outbound WebSocket buffering per client before the slow consumer is disconnected; integer 1024–16777216 bytes. |
| `REALTIME_PUBLISH_TIMEOUT_MS` | `750` | Bound on transient Redis location publish latency after PostgreSQL persistence, integer 100–10000 ms. A timeout drops that live event; clients recover current state/history from REST. |

Realtime WebSocket ticket lifetime is fixed at 30 seconds and tickets are one-use Redis keys. The ticket endpoint and GPS operations use the existing `REDIS_URL`; no separate real-time credential is required. A dedicated Redis Pub/Sub connection is used so the rate-limit client remains available for regular commands. Limits are per API process, so deployments behind a load balancer should also enforce global connection limits at the proxy. The per-IP limit uses the TCP peer address. Location-history date ranges cannot exceed the configured retention period. Realtime metrics are process-local and available only through the existing protected metrics route.
| `EMAIL_PROVIDER` | `console` | `resend` sends through the Resend API. `console` is development-only and explicitly reports that messages were not delivered. |
| `EMAIL_API_KEY` | Unset | Resend API key. Required in production; never logged. |
| `EMAIL_FROM` | `no-reply@example.test` | Valid sender email address; production must explicitly configure a provider-verified sender. |
| `APP_BASE_URL` | `http://localhost:5173` | Frontend base URL used to build verification/reset links. Production requires HTTPS. |
| `EMAIL_TOKEN_ENCRYPTION_KEY` | Unset | Separate 32-byte AES key encoded as exactly 64 hex characters. Required for auth-email queue processing and in production. Keep the same value on API and worker services. |
| `EMAIL_VERIFICATION_TTL_MINUTES` | `1440` | Verification-token lifetime, integer 1–10080 minutes. |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | Password-reset token lifetime, integer 1–1440 minutes. |
| `SLACK_WEBHOOK_URL` | Unset | Optional HTTPS Slack Incoming Webhook. Never log its value. |
| `API_DOCS_ENABLED` | `auto` | `auto` enables docs outside production and disables them in production; explicit `true`/`false` overrides. |
| `API_DOCS_ACCESS_TOKEN` | Unset | At least 32 characters. Required when docs are enabled in production. Production Swagger UI uses HTTP Basic username `docs` and this token as its password. |
| `METRICS_ACCESS_TOKEN` | Unset | At least 32 characters when configured. Enables the private metrics route; requests must use it as a Bearer token. If unset, the route returns 404. |

## Production checklist

- Set explicit PostgreSQL and Redis URLs using the deployment secret store.
- Set independent high-entropy JWT signing secrets.
- Set each allowed frontend origin explicitly; credentials are enabled and wildcard origins are rejected.
- Keep `API_DOCS_ENABLED` unset/`auto` or set it to `false` unless protected production docs are needed. If enabled, configure `API_DOCS_ACCESS_TOKEN`.
- Configure `METRICS_ACCESS_TOKEN` only for an authorized metrics collector or operator.
- Set `TRUST_PROXY_HOPS` only when the app is behind a known number of trusted proxies.
- Tune `GRACEFUL_SHUTDOWN_TIMEOUT_MS` for the platform's termination window.
- Run at least one dedicated worker process per deployment. Worker concurrency and retry retention are configurable with the `JOB_*` variables above.
- Run the worker process to drain the PostgreSQL transactional outbox as well as BullMQ queues. Tune the `OUTBOX_*` polling, lease, batch, attempt, and backoff settings for deployment capacity.
- Configure `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, provider-verified `EMAIL_FROM`, HTTPS `APP_BASE_URL`, and a separately generated `EMAIL_TOKEN_ENCRYPTION_KEY` in both API and worker services.

## Integration-test-only variables

`backend/scripts/test-integration.ps1` sets `FLEETFLOW_RUN_INTEGRATION`, `FLEETFLOW_TEST_DATABASE_URL`, `FLEETFLOW_TEST_REDIS_URL`, and isolated `DATABASE_URL`/`REDIS_URL` values for the disposable test services. These are generated by the script and are not application deployment settings.

## Audit retention and access

Audit access uses the existing authenticated `ADMIN` and `SUPER_ADMIN` roles and the shared Redis rate limiter; it has no additional environment variable. Audit rows are not automatically purged. Select retention, archival, backup, and database-administrator access policies for the deployment. Records are not cryptographically tamper-proof.
