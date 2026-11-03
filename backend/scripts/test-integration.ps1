$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $backendRoot
$composeFile = Join-Path $repoRoot "docker-compose.integration.yml"
$composeProject = "fleetflow-integration"
$testDatabaseUrl = "postgresql://fleetflow_test:fleetflow_test_only@127.0.0.1:55432/fleetflow_test?schema=public"
$testRedisUrl = "redis://127.0.0.1:56379/0"
$serviceStarted = $false

Push-Location $backendRoot
try {
  $env:FLEETFLOW_RUN_INTEGRATION = "1"
  $env:FLEETFLOW_TEST_DATABASE_URL = $testDatabaseUrl
  $env:DATABASE_URL = $testDatabaseUrl
  $env:FLEETFLOW_TEST_REDIS_URL = $testRedisUrl
  $env:REDIS_URL = $testRedisUrl
  $env:NODE_ENV = "test"
  $env:JWT_ACCESS_SECRET = "integration_only_access_secret_123456"
  $env:JWT_REFRESH_SECRET = "integration_only_refresh_secret_123456"
  $env:SLACK_WEBHOOK_URL = "https://integration.invalid/slack"
  $env:EMAIL_PROVIDER = "console"
  $env:EMAIL_FROM = "integration@example.test"
  $env:APP_BASE_URL = "http://127.0.0.1:5173"
  $env:EMAIL_TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000000"

  docker compose -p $composeProject -f $composeFile up -d --wait postgres-integration redis-integration
  if ($LASTEXITCODE -ne 0) { throw "Could not start isolated integration PostgreSQL." }
  $serviceStarted = $true

  npx.cmd prisma migrate deploy --config prisma7.config.ts
  if ($LASTEXITCODE -ne 0) { throw "Could not apply existing migrations to isolated integration PostgreSQL." }

  npx.cmd tsx --test tests/postgres.integration.test.ts tests/redis.integration.test.ts tests/jobs.integration.test.ts tests/email.integration.test.ts tests/auth-recovery.integration.test.ts tests/audit.integration.test.ts tests/authorization.integration.test.ts tests/transactional-reliability.integration.test.ts
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL integration tests failed." }
}
finally {
  if ($serviceStarted) {
    docker compose -p $composeProject -f $composeFile down --remove-orphans
  }
  Pop-Location
}
