-- CreateTable
CREATE TABLE "driver_locations" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "delivery_id" UUID,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "driver_locations_driver_id_recorded_at_idx" ON "driver_locations"("driver_id", "recorded_at");

-- CreateIndex
CREATE INDEX "driver_locations_delivery_id_recorded_at_idx" ON "driver_locations"("delivery_id", "recorded_at");

-- AddForeignKey
ALTER TABLE "driver_locations" ADD CONSTRAINT "driver_locations_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_locations" ADD CONSTRAINT "driver_locations_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
