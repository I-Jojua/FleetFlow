CREATE TYPE "DriverAvailability" AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'ON_BREAK', 'OFF_DUTY', 'SUSPENDED');
CREATE TYPE "VehicleType" AS ENUM ('MOTORCYCLE', 'CAR', 'VAN', 'TRUCK', 'REFRIGERATED_TRUCK');
CREATE TYPE "VehicleStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'INACTIVE');
CREATE TYPE "QualificationVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE "DriverShiftStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

ALTER TABLE "users"
  ADD COLUMN "availability" "DriverAvailability" NOT NULL DEFAULT 'AVAILABLE';

CREATE TABLE "vehicles" (
  "id" UUID NOT NULL,
  "registration_identifier" VARCHAR(32) NOT NULL,
  "type" "VehicleType" NOT NULL,
  "maximum_payload_kg" DECIMAL(10,2) NOT NULL,
  "maximum_volume_cubic_meters" DECIMAL(10,3),
  "refrigerated" BOOLEAN NOT NULL DEFAULT false,
  "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
  "description" VARCHAR(250),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vehicles_payload_positive" CHECK ("maximum_payload_kg" > 0),
  CONSTRAINT "vehicles_volume_positive" CHECK ("maximum_volume_cubic_meters" IS NULL OR "maximum_volume_cubic_meters" > 0)
);
CREATE UNIQUE INDEX "vehicles_registration_identifier_key" ON "vehicles"("registration_identifier");
CREATE INDEX "vehicles_type_status_idx" ON "vehicles"("type", "status");
CREATE INDEX "vehicles_status_maximum_payload_kg_idx" ON "vehicles"("status", "maximum_payload_kg");

ALTER TABLE "deliveries"
  ADD COLUMN "required_vehicle_type" "VehicleType",
  ADD COLUMN "minimum_payload_kg" DECIMAL(10,2),
  ADD COLUMN "minimum_volume_cubic_meters" DECIMAL(10,3),
  ADD COLUMN "requires_refrigerated_transport" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "required_qualifications" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "vehicle_id" UUID;
ALTER TABLE "deliveries"
  ADD CONSTRAINT "deliveries_minimum_payload_positive" CHECK ("minimum_payload_kg" IS NULL OR "minimum_payload_kg" > 0),
  ADD CONSTRAINT "deliveries_minimum_volume_positive" CHECK ("minimum_volume_cubic_meters" IS NULL OR "minimum_volume_cubic_meters" > 0),
  ADD CONSTRAINT "deliveries_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "deliveries_vehicle_id_idx" ON "deliveries"("vehicle_id");

CREATE TABLE "driver_vehicle_assignments" (
  "id" UUID NOT NULL,
  "driver_id" UUID NOT NULL,
  "vehicle_id" UUID NOT NULL,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMPTZ(3),
  CONSTRAINT "driver_vehicle_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_vehicle_assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "driver_vehicle_assignments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "driver_vehicle_assignments_end_after_start" CHECK ("ended_at" IS NULL OR "ended_at" > "started_at")
);
CREATE INDEX "driver_vehicle_assignments_driver_id_ended_at_started_at_idx" ON "driver_vehicle_assignments"("driver_id", "ended_at", "started_at");
CREATE INDEX "driver_vehicle_assignments_vehicle_id_ended_at_started_at_idx" ON "driver_vehicle_assignments"("vehicle_id", "ended_at", "started_at");
CREATE UNIQUE INDEX "driver_vehicle_assignments_one_active_driver_key" ON "driver_vehicle_assignments"("driver_id") WHERE "ended_at" IS NULL;
CREATE UNIQUE INDEX "driver_vehicle_assignments_one_active_vehicle_key" ON "driver_vehicle_assignments"("vehicle_id") WHERE "ended_at" IS NULL;

CREATE TABLE "driver_qualifications" (
  "id" UUID NOT NULL,
  "driver_id" UUID NOT NULL,
  "qualification_type" VARCHAR(60) NOT NULL,
  "license_category" VARCHAR(20),
  "issued_at" TIMESTAMPTZ(3),
  "expires_at" TIMESTAMPTZ(3),
  "verification_status" "QualificationVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "verified_at" TIMESTAMPTZ(3),
  "verified_by_id" UUID,
  "notes" VARCHAR(500),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "driver_qualifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_qualifications_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "driver_qualifications_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "driver_qualifications_valid_dates" CHECK ("issued_at" IS NULL OR "expires_at" IS NULL OR "expires_at" >= "issued_at")
);
CREATE INDEX "driver_qualifications_driver_id_qualification_type_verification_status_idx" ON "driver_qualifications"("driver_id", "qualification_type", "verification_status");
CREATE INDEX "driver_qualifications_verification_status_expires_at_idx" ON "driver_qualifications"("verification_status", "expires_at");

CREATE TABLE "driver_shifts" (
  "id" UUID NOT NULL,
  "driver_id" UUID NOT NULL,
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "timezone" VARCHAR(64) NOT NULL,
  "status" "DriverShiftStatus" NOT NULL DEFAULT 'SCHEDULED',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "driver_shifts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_shifts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "driver_shifts_valid_window" CHECK ("ends_at" > "starts_at")
);
CREATE INDEX "driver_shifts_driver_id_status_starts_at_ends_at_idx" ON "driver_shifts"("driver_id", "status", "starts_at", "ends_at");
