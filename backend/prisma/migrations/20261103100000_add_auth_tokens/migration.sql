CREATE TYPE "AuthTokenPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "AuthTokenPurpose" NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "invalidated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");
CREATE INDEX "auth_tokens_user_id_purpose_expires_at_idx" ON "auth_tokens"("user_id", "purpose", "expires_at");
CREATE INDEX "auth_tokens_purpose_expires_at_idx" ON "auth_tokens"("purpose", "expires_at");

ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;