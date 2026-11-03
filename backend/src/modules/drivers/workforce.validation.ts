import { z } from "zod";

const offsetDateTime = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const timezone = z.string().trim().min(1).max(64).refine((value) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}, "Must be a valid IANA timezone.");

export const updateAvailabilitySchema = z.object({
  availability: z.enum(["AVAILABLE", "UNAVAILABLE", "ON_BREAK", "OFF_DUTY", "SUSPENDED"]),
});

export const createQualificationSchema = z.object({
  qualificationType: z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
    .transform((value) => value.toUpperCase()),
  licenseCategory: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/)
    .transform((value) => value.toUpperCase()).optional(),
  issuedAt: offsetDateTime.optional(),
  expiresAt: offsetDateTime.optional(),
  notes: z.string().trim().max(500).optional(),
}).refine((data) => !data.issuedAt || !data.expiresAt || data.expiresAt >= data.issuedAt, {
  path: ["expiresAt"], message: "Expiration must be on or after the issue date.",
});

export const qualificationListQuerySchema = z.object({
  verificationStatus: z.enum(["PENDING", "VERIFIED", "REJECTED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const verifyQualificationSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
});

export const createShiftSchema = z.object({
  startsAt: offsetDateTime,
  endsAt: offsetDateTime,
  timezone,
}).refine((data) => data.endsAt > data.startsAt, {
  path: ["endsAt"], message: "Shift end must be later than shift start.",
});

export const updateShiftSchema = createShiftSchema;

export const updateShiftStatusSchema = z.object({
  status: z.enum(["ACTIVE", "COMPLETED", "CANCELLED"]),
});

export const shiftListQuerySchema = z.object({
  status: z.enum(["SCHEDULED", "ACTIVE", "COMPLETED", "CANCELLED"]).optional(),
  from: offsetDateTime.optional(),
  to: offsetDateTime.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).refine((filters) => !filters.from || !filters.to || filters.to >= filters.from, {
  path: ["to"], message: "The to date must be on or after from.",
});

export type CreateQualificationInput = z.infer<typeof createQualificationSchema>;
export type CreateShiftInput = z.infer<typeof createShiftSchema>;
