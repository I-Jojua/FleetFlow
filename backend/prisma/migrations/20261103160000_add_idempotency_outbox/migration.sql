CREATE TYPE "OutboxEventType" AS ENUM ('AUTH_EMAIL');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "idempotency_records" (
  "id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "operation" VARCHAR(100) NOT NULL,
  "key_hash" VARCHAR(64) NOT NULL,
  "request_fingerprint" VARCHAR(64) NOT NULL,
  "resource_type" VARCHAR(50) NOT NULL,
  "resource_id" VARCHAR(100) NOT NULL,
  "response_status" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idempotency_records_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "idempotency_records_actor_id_operation_key_hash_key"
  ON "idempotency_records"("actor_id", "operation", "key_hash");
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");
CREATE INDEX "idempotency_records_actor_id_created_at_idx" ON "idempotency_records"("actor_id", "created_at");

CREATE TABLE "outbox_events" (
  "id" UUID NOT NULL,
  "event_type" "OutboxEventType" NOT NULL,
  "dedupe_key" VARCHAR(180) NOT NULL,
  "payload" JSONB,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "processed_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "last_error_code" VARCHAR(100),
  "request_id" VARCHAR(100),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outbox_events_dedupe_key_key" ON "outbox_events"("dedupe_key");
CREATE INDEX "outbox_events_status_available_at_created_at_idx"
  ON "outbox_events"("status", "available_at", "created_at");
CREATE INDEX "outbox_events_status_locked_at_idx" ON "outbox_events"("status", "locked_at");
CREATE INDEX "outbox_events_created_at_idx" ON "outbox_events"("created_at");
