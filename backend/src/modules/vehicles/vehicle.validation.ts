import { z } from "zod";

const registrationIdentifier = z.string().trim().min(2).max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/)
  .transform((value) => value.replace(/\s+/g, " ").toUpperCase());

export const createVehicleSchema = z.object({
  registrationIdentifier,
  type: z.enum(["MOTORCYCLE", "CAR", "VAN", "TRUCK", "REFRIGERATED_TRUCK"]),
  maximumPayloadKg: z.number().positive().max(1_000_000),
  maximumVolumeCubicMeters: z.number().positive().max(1_000_000).optional(),
  refrigerated: z.boolean().default(false),
  description: z.string().trim().max(250).optional(),
});

export const updateVehicleSchema = z.object({
  registrationIdentifier: registrationIdentifier.optional(),
  type: z.enum(["MOTORCYCLE", "CAR", "VAN", "TRUCK", "REFRIGERATED_TRUCK"]).optional(),
  maximumPayloadKg: z.number().positive().max(1_000_000).optional(),
  maximumVolumeCubicMeters: z.number().positive().max(1_000_000).nullable().optional(),
  refrigerated: z.boolean().optional(),
  description: z.string().trim().max(250).nullable().optional(),
}).refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided." });

export const updateVehicleStatusSchema = z.object({
  status: z.enum(["ACTIVE", "MAINTENANCE", "INACTIVE"]),
});

export const vehicleListQuerySchema = z.object({
  status: z.enum(["ACTIVE", "MAINTENANCE", "INACTIVE"]).optional(),
  type: z.enum(["MOTORCYCLE", "CAR", "VAN", "TRUCK", "REFRIGERATED_TRUCK"]).optional(),
  search: z.string().trim().max(32).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const assignVehicleSchema = z.object({ driverId: z.string().uuid() });

export const assignmentHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;
export type VehicleListQuery = z.infer<typeof vehicleListQuerySchema>;
