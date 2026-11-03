
import { z } from "zod";

export const registerSchema = z.object({
  firstName: z.string().trim().min(2).max(100),
  lastName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(255).transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
  phone: z.string().trim().min(7).max(30).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

export const emailTokenSchema = z.object({
  token: z.string().min(20).max(256),
});

export const emailAddressSchema = z.object({
  email: z.string().trim().email().max(255).transform((value) => value.toLowerCase()),
});

export const passwordResetSchema = z.object({
  token: z.string().min(20).max(256),
  password: z.string().min(8).max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
