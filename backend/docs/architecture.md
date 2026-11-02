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
      └─ safe error handler
```

## Modules

- **Authentication:** controllers validate requests, services manage password hashing, JWT access tokens, refresh-token rotation and revocation. Bearer authentication loads the active user and the role middleware restricts staff and driver operations.
- **Deliveries:** routes select public tracking or authenticated operations. Controllers enforce caller/resource ownership; services implement creation, state transitions, assignment, event persistence and location history.
- **Drivers and customers:** their services own account creation, profile/list queries, status updates and status-specific statistics.
- **Notifications:** records belong to a user and may refer to a delivery. Delivery workflows persist notifications best-effort; Slack alerts are also best-effort.
- **Health and operations:** liveness is independent of dependencies; readiness probes PostgreSQL and Redis. In-process metrics are available only with the metrics bearer token.
- **Documentation:** the OpenAPI 3.1 document is checked in at `backend/docs/openapi.json`. Swagger UI is available in development; production docs are disabled by default and token-protected when enabled.

## Observability boundaries

Request logs include a generated request ID, method, route template, response status and duration. Query strings, route parameter values, body content, IP addresses and raw error objects are not logged. Request IDs flow through asynchronous work using `AsyncLocalStorage`.

Metrics are in-memory process-local aggregates with no user, IP, path, or delivery labels. Request counts, status counts, errors and duration summaries reset when the process restarts. Database and Redis availability show the last observed probe/limiter result and can be `unknown` until observed. Use a metrics collector or external monitoring for durable history and cross-instance aggregation.
