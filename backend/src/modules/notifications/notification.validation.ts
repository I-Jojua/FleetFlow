import { z } from "zod";
import { paginationQuerySchema } from "../../middleware/request-validation.js";

export const notificationQuerySchema = paginationQuerySchema.extend({
  unreadOnly: z.enum(["true", "false"]).optional().transform(
    (value) => value === "true",
  ),
});
