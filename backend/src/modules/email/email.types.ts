export type AuthEmailTemplate = "verify-email" | "password-reset";

export interface EmailJobPayload {
  to: string;
  template: AuthEmailTemplate;
  encryptedToken: string;
  requestId?: string;
}

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailDeliveryResult {
  delivered: boolean;
  provider: "resend" | "console";
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}
