-- Create an index used by the scheduled GPS history retention cleanup.
CREATE INDEX "driver_locations_recorded_at_idx" ON "driver_locations"("recorded_at");
