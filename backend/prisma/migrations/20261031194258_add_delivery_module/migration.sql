-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED');

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "tracking_code" VARCHAR(30) NOT NULL,
    "customer_id" UUID NOT NULL,
    "driver_id" UUID,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "recipient_name" VARCHAR(150) NOT NULL,
    "recipient_phone" VARCHAR(30) NOT NULL,
    "pickup_address" VARCHAR(500) NOT NULL,
    "pickup_latitude" DECIMAL(10,7),
    "pickup_longitude" DECIMAL(10,7),
    "delivery_address" VARCHAR(500) NOT NULL,
    "delivery_latitude" DECIMAL(10,7),
    "delivery_longitude" DECIMAL(10,7),
    "package_description" TEXT,
    "package_weight" DECIMAL(10,2),
    "notes" TEXT,
    "assigned_at" TIMESTAMP(3),
    "picked_up_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_events" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "actor_id" UUID,
    "status" "DeliveryStatus" NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_tracking_code_key" ON "deliveries"("tracking_code");

-- CreateIndex
CREATE INDEX "deliveries_customer_id_idx" ON "deliveries"("customer_id");

-- CreateIndex
CREATE INDEX "deliveries_driver_id_idx" ON "deliveries"("driver_id");

-- CreateIndex
CREATE INDEX "deliveries_status_idx" ON "deliveries"("status");

-- CreateIndex
CREATE INDEX "deliveries_created_at_idx" ON "deliveries"("created_at");

-- CreateIndex
CREATE INDEX "delivery_events_delivery_id_idx" ON "delivery_events"("delivery_id");

-- CreateIndex
CREATE INDEX "delivery_events_actor_id_idx" ON "delivery_events"("actor_id");

-- CreateIndex
CREATE INDEX "delivery_events_created_at_idx" ON "delivery_events"("created_at");

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
