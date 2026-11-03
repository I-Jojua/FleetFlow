import { z } from "zod";

export const authEmailOutboxPayloadSchema = z.object({
  authTokenId: z.string().uuid(),
  encryptedToken: z.string().min(32).max(512),
  template: z.enum(["verify-email", "password-reset"]),
}).strict();

export type AuthEmailOutboxPayload = z.infer<typeof authEmailOutboxPayloadSchema>;
