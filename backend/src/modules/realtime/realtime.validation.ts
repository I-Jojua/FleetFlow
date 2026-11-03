import { z } from "zod";

export const realtimeClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe_delivery"), deliveryId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("unsubscribe_delivery"), deliveryId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("subscribe_active_drivers") }).strict(),
  z.object({ type: z.literal("unsubscribe_active_drivers") }).strict(),
]);

export const realtimeLocationEventSchema = z.object({
  type: z.literal("driver_location"),
  driverId: z.string().uuid(),
  deliveryId: z.string().uuid(),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().positive().max(100_000).nullable(),
  recordedAt: z.string().datetime(),
  requestId: z.string().max(100).optional(),
});

export type RealtimeLocationEvent = z.infer<typeof realtimeLocationEventSchema>;
