CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_role" "UserRole",
    "action" VARCHAR(100) NOT NULL,
    "resource_type" VARCHAR(50) NOT NULL,
    "resource_id" VARCHAR(100),
    "outcome" "AuditOutcome" NOT NULL,
    "request_id" VARCHAR(100),
    "ip_address" VARCHAR(45),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_actor_user_id_created_at_id_idx" ON "audit_logs"("actor_user_id", "created_at", "id");
CREATE INDEX "audit_logs_action_created_at_id_idx" ON "audit_logs"("action", "created_at", "id");
CREATE INDEX "audit_logs_resource_type_resource_id_created_at_id_idx" ON "audit_logs"("resource_type", "resource_id", "created_at", "id");
CREATE INDEX "audit_logs_outcome_created_at_id_idx" ON "audit_logs"("outcome", "created_at", "id");
CREATE INDEX "audit_logs_created_at_id_idx" ON "audit_logs"("created_at", "id");

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
