# Architecture overview

```text
HTTP client
  └─ Express app
      ├─ request ID + request metrics/logging
      ├─ Helmet, configured CORS, JSON parsing
      ├─ route middleware (rate limit, auth, role checks, validation)
      ├─ controllers
      ├─ module services
      │   ├─ Prisma PostgreSQL client
      │   ├─ Redis shared rate-limit store
      │   └─ best-effort notification / Slack integration
      ├─ BullMQ queue producer
      │   └─ centralized demo and auth-email queues over validated REDIS_URL
      └─ safe error handler

Separate worker process
  └─ BullMQ Worker (dedicated blocking Redis connection)
      ├─ typed demo job processor
      └─ auth-email processor → AES-GCM token decrypt → provider adapter
      └─ PostgreSQL outbox poller → stable auth-email BullMQ jobs
```

## Modules

- **Authentication:** controllers validate requests, services manage password hashing, JWT access tokens, refresh-token rotation and revocation. Bearer authentication loads the active user and the role middleware restricts staff and driver operations.
- **Authorization:** roles come from the current active user row, never from caller-controlled JWT role claims or request bodies. Route-level role checks are paired with service/database ownership predicates for customer deliveries, assigned driver deliveries, GPS reads/writes, and per-user notifications. See [authorization matrix](authorization-matrix.md) for the complete mounted-route policy. An authenticated caller outside a delivery's ownership scope receives the same 404 as an unknown delivery on detail and GPS read endpoints.
- **Deliveries:** routes select public tracking or authenticated operations. Controllers enforce caller/resource ownership; services implement creation, state transitions, assignment, event persistence and location history.
- **Drivers and customers:** their services own account creation, profile/list queries, status updates and status-specific statistics.
- **Notifications:** records belong to a user and may refer to a delivery. Delivery workflows persist notifications best-effort; Slack alerts are also best-effort.
- **Health and operations:** liveness is independent of dependencies; readiness probes PostgreSQL and Redis. In-process metrics are available only with the metrics bearer token.
- **Documentation:** the OpenAPI 3.1 document is checked in at `backend/docs/openapi.json`. Swagger UI is available in development; production docs are disabled by default and token-protected when enabled.
- **Background jobs:** the API process owns the centralized BullMQ producer registry. Worker processes start separately with `npm run worker` and consume the same registered queue names using validated `REDIS_URL`. BullMQ creates role-appropriate Redis connections because blocking worker connections need different retry settings from the low-latency API Redis client. Submission resolves only after Redis acknowledges the job; failures propagate to the caller. Jobs use exponential retries and bounded completed/failed retention. Processing is at-least-once, so future business processors must be idempotent. Worker SIGTERM/SIGINT handlers stop new work and drain active jobs within the configured shutdown timeout.
- **Authentication emails:** registration, verification resend, and password-reset requests write their single-use token and an encrypted outbox event in the same PostgreSQL transaction as the associated account/token operation. The outbox dispatcher resolves the current recipient from the referenced account, decrypts the email token in memory, and enqueues it into the existing BullMQ email queue with a stable token-based job ID. The email worker then renders centralized HTML/text templates and calls the selected provider. PostgreSQL stores only SHA-256 token hashes in `AuthToken`; outbox payloads contain AES-256-GCM ciphertext, never plaintext tokens or email addresses. The encryption key must be provisioned consistently to API and worker services. The development `console` provider deliberately reports that mail was not delivered. Outbox enqueue attempts retry exponentially and recover stale processing leases; queue and provider delivery are at-least-once, not exactly-once.
- **Audit logs:** action names are `auth.login`, `auth.logout`, `auth.email.verify`, `auth.password_reset`, `users.create`, `drivers.create`, `drivers.update`, `drivers.status_update`, `customers.create`, `customers.update`, `customers.status_update`, `deliveries.create`, `deliveries.assign_driver`, `deliveries.status_update`, and `deliveries.cancel`. `AuditLog` records authentication outcomes, account creation/status changes, driver/customer changes and delivery operations. Successful critical writes insert their audit row in the same PostgreSQL transaction. Failed sign-in and rejected verification/reset tokens create awaited anonymous/security audit records separately because no successful business transaction exists. Actor role is snapshotted; deleted users leave audit records with a null actor reference. Metadata is restricted to an allowlist of enum-like state/reason values and changed field names. IP is stored only for authentication/security events and privileged administrative changes, taken from Express's trusted `req.ip` after proxy settings and IP validation. `GET /api/v1/audit-logs` is read-only, paginated, filtered, rate-limited and restricted to ADMIN/SUPER_ADMIN; no public mutation or single-record endpoint exists.

Audit logs are ordinary PostgreSQL records with indexes and foreign-key behavior, not cryptographically signed or tamper-proof. Database administrators can still alter them. Set retention, archival, access review and backups according to policy; this application does not automatically delete audit history. User role changes are not audited because the current API has no role-change operation.

Role permissions are defined at the route layer and verified against database-backed integration tests for identity, role spoofing, inactive accounts, and nested delivery/location ownership. This is application authorization and does not prevent privileged database operators from bypassing it.

Idempotency applies only when a client opts in with `Idempotency-Key` on delivery creation or driver assignment. Keys are scoped to actor and operation, stored only as hashes with a canonical request fingerprint and a reference to the result resource, and expire after the configured retention period. PostgreSQL transaction advisory locks serialize same-key concurrent retries. Replays return the resource referenced by the committed result; the response body is reconstructed from current database state and is not stored as a potentially sensitive snapshot.

The transactional outbox has `PENDING`, `PROCESSING`, `COMPLETED`, and `FAILED` states. Each claim increments attempts and sets a lease; stale leases are reclaimable after worker crashes. Transient queue submission failures are rescheduled with exponential backoff and permanent failures retain a safe error class for operator review. Completed rows have their encrypted payload cleared. BullMQ stable job IDs deduplicate while a job record is retained, but Redis enqueue and PostgreSQL completion are not one atomic transaction; delivery is at-least-once and downstream email providers may receive duplicates after a crash at the acknowledgement boundary. There is no exactly-once guarantee.

## Observability boundaries

Request logs include a generated request ID, method, route template, response status and duration. Query strings, route parameter values, body content, IP addresses and raw error objects are not logged. Request IDs flow through asynchronous work using `AsyncLocalStorage`.

Metrics are in-memory process-local aggregates with no user, IP, path, or delivery labels. Request counts, status counts, errors and duration summaries reset when the process restarts. Database and Redis availability show the last observed probe/limiter result and can be `unknown` until observed. Use a metrics collector or external monitoring for durable history and cross-instance aggregation.
