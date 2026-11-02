# FleetFlow

FleetFlow is a delivery management API built with Node.js, TypeScript, Express, PostgreSQL, and Prisma. It manages customer and driver accounts, delivery lifecycle, GPS location history, notifications, and public privacy-limited tracking.

## Documentation

- [OpenAPI 3.1 document](backend/docs/openapi.json)
- [API response consistency review](backend/docs/response-consistency.md)
- [Environment variable reference](backend/docs/environment.md)
- [Architecture overview](backend/docs/architecture.md)

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

`npm.cmd test` runs unit tests; PostgreSQL and Redis integration tests are skipped unless the dedicated integration mode is enabled. `npm.cmd run test:integration` starts isolated test services, applies the existing migrations to the empty test database, runs the integration tests, and cleans up the isolated services.

## Production configuration

Production requires explicit `DATABASE_URL`, `REDIS_URL`, two distinct strong JWT secrets, and `CORS_ALLOWED_ORIGINS`. Set secrets through the deployment platform's secret manager; do not put production values in source control or logs. Swagger docs are disabled by default in production. If explicitly enabled, protect them with `API_DOCS_ACCESS_TOKEN`. The operational metrics endpoint is disabled until `METRICS_ACCESS_TOKEN` is configured.

See the complete [environment variable reference](backend/docs/environment.md) for defaults, validation, and production requirements.
