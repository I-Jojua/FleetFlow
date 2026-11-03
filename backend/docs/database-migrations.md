# Database migrations and transactional outbox

## Migration policy

FleetFlow uses the checked-in Prisma migration history. This stage adds `20261103160000_add_idempotency_outbox`; previous migration files are unchanged. The migration creates `idempotency_records`, `outbox_events`, their enums, unique constraints and scan indexes. It does not rewrite or delete existing application data.

Apply migrations from `C:\Users\ninoj\FleetFlow\backend`:

```powershell
npx.cmd prisma migrate deploy --config prisma7.config.ts
npx.cmd prisma validate --config prisma7.config.ts
```

Use the deployment environment's configured `DATABASE_URL` and secret manager. Do not use `migrate reset`, `db push`, or Docker volume removal for production or development data. Integration tests use only the isolated database on port 55432 with an ephemeral filesystem.

## Idempotency records

`IdempotencyRecord` stores actor ID, operation, SHA-256 key hash, canonical request fingerprint, result resource type/ID, response status and expiry. Raw keys and request/response bodies are not stored. A transaction-scoped PostgreSQL advisory lock serializes requests for the same actor/operation/key. The unique constraint is the final database invariant. Expired records for a given key are deleted and replaced when that key is used again; expired rows for keys that are never reused may remain until operational cleanup is added.

Initially enabled endpoints:

- `POST /api/v1/deliveries`
- `PATCH /api/v1/deliveries/{id}/assign`

Clients may omit the header to preserve existing behavior. A replay reloads the referenced delivery, so if it has changed since the original request, the response contains its current persisted state. Same-key/different-fingerprint requests receive `409 IDEMPOTENCY_KEY_REUSED`.

## Outbox lifecycle

`OutboxEvent` payloads are schema-validated before processing. Currently the only event type is `AUTH_EMAIL`; payloads include an auth-token record ID, template name and AES-GCM-encrypted one-time token. Recipient addresses are resolved at processing time from the account relation and are not copied into the outbox row. Completed events clear payload ciphertext. Failed events retain ciphertext for operator diagnosis/replay and should be governed by restricted database access and retention policy.

The worker polls due `PENDING` events and reclaims `PROCESSING` events whose `lockedAt` lease has expired. Conditional updates claim each event once per lease even when multiple worker processes scan simultaneously. Attempts are bounded by `OUTBOX_MAX_ATTEMPTS`, with exponential delay beginning at `OUTBOX_BACKOFF_BASE_MS`. Queue submission uses the existing stable token-based BullMQ job ID. Permanent errors retain only an error class, not raw provider/Redis messages.

Outbox and BullMQ/Redis are separate systems. The worker can crash after Redis acknowledges a job but before PostgreSQL marks the event `COMPLETED`; a recovered event can therefore be submitted again. BullMQ deduplicates matching job IDs only while the retained job record exists, and email-provider retries may still duplicate a message. The system provides **at-least-once processing**, not exactly-once delivery. Monitor `FAILED` outbox rows and configure retention, alerting and backups for operational requirements.

Start the worker from `C:\Users\ninoj\FleetFlow\backend` after building:

```powershell
npm.cmd run worker:start
```

For local development, run `npm.cmd run worker` in its own terminal beside the API process. The outbox poller stops with the worker's existing SIGINT/SIGTERM graceful shutdown and closes its BullMQ producer connection.
