import { z } from "zod";

const dateFilter = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const auditLogQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  actorUserId: z.string().uuid().optional(),
  action: z.string().regex(/^[a-z][a-z0-9_.-]{1,99}$/).optional(),
  resourceType: z.string().regex(/^[a-z][a-z0-9_-]{1,49}$/).optional(),
  resourceId: z.string().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
  outcome: z.enum(["SUCCESS", "FAILURE", "DENIED"]).optional(),
  from: dateFilter.optional(),
  to: dateFilter.optional(),
}).strict().refine((query) => !query.from || !query.to || query.from <= query.to, {
  message: "The from date must be earlier than or equal to the to date.",
  path: ["from"],
});

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
