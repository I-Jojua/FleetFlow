
import { z } from "zod";

export const createDeliverySchema = z.object({
  recipientName: z.string().trim().min(2).max(150),
  recipientPhone: z.string().trim().min(5).max(30),

  pickupAddress: z.string().trim().min(5).max(500),
  pickupLatitude: z.number().min(-90).max(90).optional(),
  pickupLongitude: z.number().min(-180).max(180).optional(),

  deliveryAddress: z.string().trim().min(5).max(500),
  deliveryLatitude: z.number().min(-90).max(90).optional(),
  deliveryLongitude: z.number().min(-180).max(180).optional(),

  packageDescription: z.string().trim().max(5000).optional(),
  packageWeight: z.number().positive().max(10000).optional(),

  notes: z.string().trim().max(5000).optional(),
});

export const assignDriverSchema = z.object({
  driverId: z.string().uuid(),
});

export type CreateDeliveryInput = z.infer<
  typeof createDeliverySchema
>;

export type AssignDriverInput = z.infer<
  typeof assignDriverSchema
>;

export const updateDeliveryStatusSchema = z.object({
  status: z.enum([
    "PICKED_UP",
    "IN_TRANSIT",
    "DELIVERED",
    "CANCELLED",
  ]),
});

export type UpdateDeliveryStatusInput = z.infer<
  typeof updateDeliveryStatusSchema
>;

export const deliveryQuerySchema = z.object({
  search: z.string().trim().optional(),

  status: z.enum([
    "PENDING",
    "ASSIGNED",
    "PICKED_UP",
    "IN_TRANSIT",
    "DELIVERED",
    "CANCELLED",
  ]).optional(),

  page: z.coerce.number().int().min(1).default(1),

  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export type DeliveryQueryInput = z.infer<
  typeof deliveryQuerySchema
>;

export const updateDriverLocationSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().positive().optional(),
});

export type UpdateDriverLocationInput = z.infer<
  typeof updateDriverLocationSchema
>;