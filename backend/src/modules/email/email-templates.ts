import type { AuthEmailTemplate, EmailMessage } from "./email.types.js";

export function createAuthEmail(
  template: AuthEmailTemplate,
  token: string,
  options: { to: string; from: string; appBaseUrl: string },
): EmailMessage {
  const url = new URL(template === "verify-email" ? "/verify-email" : "/reset-password", options.appBaseUrl);
  url.searchParams.set("token", token);
  const link = url.toString();

  if (template === "verify-email") {
    return {
      to: options.to,
      from: options.from,
      subject: "Verify your FleetFlow email",
      text: `Verify your FleetFlow email by opening this one-time link: ${link}`,
      html: `<p>Verify your FleetFlow email address.</p><p><a href="${link}">Verify email</a></p><p>This link can only be used once and will expire automatically.</p>`,
    };
  }

  return {
    to: options.to,
    from: options.from,
    subject: "Reset your FleetFlow password",
    text: `Reset your FleetFlow password using this one-time link: ${link}`,
    html: `<p>A password reset was requested for your FleetFlow account.</p><p><a href="${link}">Reset password</a></p><p>If you did not request this, ignore this email. This link can only be used once and will expire automatically.</p>`,
  };
}
