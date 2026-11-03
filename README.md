# FleetFlow

FleetFlow is a delivery management API built with Node.js, TypeScript, Express, PostgreSQL, and Prisma. It manages customer and driver accounts, delivery lifecycle, GPS location history, notifications, and public privacy-limited tracking.

## Documentation

- [OpenAPI 3.1 document](backend/docs/openapi.json)
- [API response consistency review](backend/docs/response-consistency.md)
- [Environment variable reference](backend/docs/environment.md)
- [Architecture overview](backend/docs/architecture.md)
- [Role and resource authorization matrix](backend/docs/authorization-matrix.md)
- [Database migration and outbox operations](backend/docs/database-migrations.md)

When the API is running in development, Swagger UI is available at `http://localhost:5000/api/v1/docs`. Production disables docs by default; see the environment reference to enable protected docs.

## Local development

Requirements: Node.js with npm and Docker Compose. Run backend commands from `C:\Users\ninoj\FleetFlow\backend`.

```powershell
Set-Location C:\Users\ninoj\FleetFlow
docker compose up -d
docker compose ps
```

The development Compose file starts PostgreSQL and Redis on localhost-bound ports and stores their development data in named Docker volumes. Starting the services does not reset them. Avoid `docker compose down -v`; that removes persistent development volumes.

Install backend dependencies and prepare the database schema:

```powershell
Set-Location C:\Users\ninoj\FleetFlow\backend
npm.cmd ci
npx.cmd prisma migrate deploy --config prisma7.config.ts
```

The application has local development defaults in `src/config/env.ts`. A local `.env` file is optional; use `backend/.env.example` as the variable reference, and never commit `.env`.

Run the API:

```powershell
npm.cmd run dev
```

The API listens on port `5000` by default. Liveness is at `GET /api/v1/health`; readiness is at `GET /api/v1/health/ready`.

## Background job worker

Start the API and worker in separate PowerShell windows from `C:\Users\ninoj\FleetFlow\backend`:

```powershell
npm.cmd run dev
```

```powershell
npm.cmd run worker
```

Submit the demonstration job from a third backend terminal with a unique alphanumeric, dash, or underscore ID:

```powershell
npm.cmd run job:demo -- local-demo-001
```

The API process registers the BullMQ producer; the worker consumes the typed `fleetflow-demo` queue. The demo processor logs start/completion and has no delivery side effects. Jobs retry up to `JOB_MAX_ATTEMPTS` with exponential backoff starting at `JOB_BACKOFF_DELAY_MS`; completed and failed job records are bounded by their configured retention counts. Duplicate IDs are idempotent while the retained job record exists. Processing is at-least-once, so real job processors must be idempotent. Workers drain active work on SIGINT/SIGTERM until `GRACEFUL_SHUTDOWN_TIMEOUT_MS`.

Production deployments should run the API and one or more `npm.cmd run worker:start` processes as separate services. Build first with `npm.cmd run build`; worker concurrency and retention use the `JOB_*` variables in the [environment reference](backend/docs/environment.md).

## Email verification and password reset

New customer registrations remain `PENDING_VERIFICATION` until verified. Authentication/role middleware already blocks inactive accounts; successful verification changes a pending account to `ACTIVE`. The existing registration response shape is preserved. New auth routes are `POST /api/v1/auth/verify-email`, `/resend-verification`, `/password-reset/request`, and `/password-reset/confirm`.

For local development, configure `EMAIL_TOKEN_ENCRYPTION_KEY` (32 random bytes represented as 64 hexadecimal characters) in the local backend environment; use a different value in every environment. `EMAIL_PROVIDER=console` is the default and deliberately does not send or print email links. To test actual link delivery, set up a Resend API key and sender as described in the [environment reference](backend/docs/environment.md). Both the API and worker need the same encryption key. Verification links expire after 24 hours by default; reset links expire after 30 minutes. Expirations are configurable. Jobs retry exponentially and retain failed records for inspection.

Token hashes are stored in PostgreSQL. Registration and recovery requests write an AES-GCM-encrypted email outbox event in the same database transaction as the account/token change. A worker drains those events into the existing BullMQ email queue; no plaintext token or recipient email is stored in the outbox payload. Keep the encryption key secret, consistent across API and workers, and do not rotate it until pending events and queued jobs have completed or expired.

## Audit logs

Recorded actions include `auth.login`, `auth.logout`, `auth.email.verify`, `auth.password_reset`, `users.create`, `drivers.create/update/status_update`, `customers.create/update/status_update`, and `deliveries.create/assign_driver/status_update/cancel`. Success/failure/denied outcomes are recorded as appropriate. Records are written with the successful business operation in one transaction where supported. Login failures are recorded as anonymous or account-targeted events without email/password values. Audit reads are available only to `ADMIN` and `SUPER_ADMIN` at `GET /api/v1/audit-logs`; filters include actor, action, resource, outcome, date range and pagination. There is no public write, update, delete, or individual-record endpoint. Metadata is allowlisted and contains field names/status snapshots, never raw request payloads or credentials. Choose retention and archival periods to match operational and legal requirements; this system does not claim cryptographic tamper-proofing.

## Idempotency and transactional outbox

Clients may include `Idempotency-Key` on delivery creation and driver assignment. Keys are actor- and operation-scoped, validated to 8–128 safe characters, and retained for `IDEMPOTENCY_KEY_TTL_HOURS` (24 by default). Retried requests with the same fingerprint replay the result; reusing a key with a different payload returns HTTP 409. Only hashes, fingerprints and resource references are stored. A replay reloads the referenced resource from PostgreSQL, so later changes to that resource are reflected in the replay response.

Account verification and password-reset requests persist encrypted `AUTH_EMAIL` outbox events atomically with their auth-token records. The worker polls the outbox, leases events, enqueues them into the existing email queue, retries transient failures exponentially, and reclaims stale leases after a worker restart. Permanent failures are marked `FAILED` for operator review. The guarantee is at-least-once: a process can fail between Redis acknowledgement and PostgreSQL completion, and the external email provider can receive a duplicate. BullMQ stable job IDs reduce duplicates while the job record is retained; they do not create an exactly-once guarantee. See [database migration and outbox operations](backend/docs/database-migrations.md).

## Docker

The root `docker-compose.yml` is for persistent local development services. PostgreSQL and Redis bind to `127.0.0.1`; named volumes preserve local data across container restarts. Use `docker compose stop` to stop the services while retaining data.

The integration test command uses a separate `docker-compose.integration.yml`: an isolated PostgreSQL database with a temporary filesystem and a non-persistent Redis service. It uses different local ports and removes only its own containers after running tests. It does not connect to the development Compose database.

## Tests and build

Run from `C:\Users\ninoj\FleetFlow\backend`:

```powershell
npm.cmd test
npm.cmd run test:integration
npm.cmd run build
```

`npm.cmd test` runs unit tests; PostgreSQL and Redis integration tests are skipped unless the dedicated integration mode is enabled. `npm.cmd run test:integration` starts isolated test services, applies migrations to the empty test database, runs the integration tests, and cleans up the isolated services.

## Production configuration

Production requires explicit `DATABASE_URL`, `REDIS_URL`, two distinct strong JWT secrets, and `CORS_ALLOWED_ORIGINS`. Set secrets through the deployment platform's secret manager; do not put production values in source control or logs. Swagger docs are disabled by default in production. If explicitly enabled, protect them with `API_DOCS_ACCESS_TOKEN`. The operational metrics endpoint is disabled until `METRICS_ACCESS_TOKEN` is configured.

See the complete [environment variable reference](backend/docs/environment.md) for defaults, validation, and production requirements.
