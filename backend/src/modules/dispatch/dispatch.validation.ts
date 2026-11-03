import { z } from "zod";

export const dispatchRecommendationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type DispatchRecommendationQuery = z.infer<typeof dispatchRecommendationQuerySchema>;
