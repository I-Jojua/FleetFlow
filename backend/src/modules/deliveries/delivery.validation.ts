
import { z } from "zod";
import { env } from "../../config/env.js";

export const createDeliverySchema = z.object({
  customerId: z.string().uuid().optional(),
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

  requiredVehicleType: z.enum(["MOTORCYCLE", "CAR", "VAN", "TRUCK", "REFRIGERATED_TRUCK"]).optional(),
  minimumPayloadKg: z.number().positive().max(1_000_000).optional(),
  minimumVolumeCubicMeters: z.number().positive().max(1_000_000).optional(),
  requiresRefrigeratedTransport: z.boolean().optional(),
  requiredQualifications: z.array(z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).transform((value) => value.toUpperCase())).max(20).optional(),

  notes: z.string().trim().max(5000).optional(),
});

export const updateDeliveryRequirementsSchema = z.object({
  requiredVehicleType: z.enum(["MOTORCYCLE", "CAR", "VAN", "TRUCK", "REFRIGERATED_TRUCK"]).nullable().optional(),
  minimumPayloadKg: z.number().positive().max(1_000_000).nullable().optional(),
  minimumVolumeCubicMeters: z.number().positive().max(1_000_000).nullable().optional(),
  requiresRefrigeratedTransport: z.boolean().optional(),
  requiredQualifications: z.array(z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).transform((value) => value.toUpperCase())).max(20).optional(),
}).refine((data) => Object.keys(data).length > 0, { message: "At least one transport requirement must be provided." })
  .refine((data) => !data.requiredQualifications || new Set(data.requiredQualifications).size === data.requiredQualifications.length, {
    path: ["requiredQualifications"], message: "Required qualifications must be unique.",
  });

export const assignDriverSchema = z.object({
  driverId: z.string().uuid(),
});

export type CreateDeliveryInput = z.infer<
  typeof createDeliverySchema
>;
export type UpdateDeliveryRequirementsInput = z.infer<typeof updateDeliveryRequirementsSchema>;

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
  latitude: z.preprocess((value) => value === "" ? Number.NaN : value, z.coerce.number().min(-90).max(90)),
  longitude: z.preprocess((value) => value === "" ? Number.NaN : value, z.coerce.number().min(-180).max(180)),
  accuracy: z.preprocess((value) => value === "" ? Number.NaN : value, z.coerce.number().positive().max(100_000)).optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
});

export const locationHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
}).refine((filters) => !filters.from || !filters.to || Date.parse(filters.from) <= Date.parse(filters.to), {
  path: ["to"],
  message: "The to date must be on or after the from date.",
}).refine((filters) => !filters.from || !filters.to ||
  Date.parse(filters.to) - Date.parse(filters.from) <= env.GPS_LOCATION_RETENTION_DAYS * 86_400_000, {
  path: ["to"],
  message: "The requested location-history range exceeds the configured retention period.",
});

export type UpdateDriverLocationInput = z.infer<
  typeof updateDriverLocationSchema
>;
