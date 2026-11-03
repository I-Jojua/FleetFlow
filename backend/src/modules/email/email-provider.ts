import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import type { EmailMessage, EmailProvider } from "./email.types.js";

export interface EmailProviderOptions {
  provider: "console" | "resend";
  apiKey?: string;
  fetcher?: typeof fetch;
  log?: typeof logger;
}

export function createEmailProvider(options: EmailProviderOptions): EmailProvider {
  const log = options.log ?? logger;
  if (options.provider === "console") {
    return {
      async send(_message: EmailMessage) {
        log.warn("email_not_delivered_development_provider", {
          provider: "console",
          delivered: false,
        });
        return { delivered: false, provider: "console" };
      },
    };
  }

  const fetcher = options.fetcher ?? fetch;
  return {
    async send(message) {
      if (!options.apiKey) throw new Error("EMAIL_API_KEY is required for the Resend provider.");
      const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Email provider request failed with status ${response.status}.`);
      }
      return { delivered: true, provider: "resend" };
    },
  };
}

export const emailProvider = createEmailProvider({
  provider: env.EMAIL_PROVIDER,
  apiKey: env.EMAIL_API_KEY,
});
