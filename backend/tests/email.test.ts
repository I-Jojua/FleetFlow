import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptEmailToken, encryptEmailToken } from "../src/modules/email/email-crypto.js";
import { createEmailProvider } from "../src/modules/email/email-provider.js";
import { enqueueAuthEmail } from "../src/modules/email/email-queue.service.js";
import { createAuthEmail } from "../src/modules/email/email-templates.js";
import type { EmailJobPayload } from "../src/modules/email/email.types.js";
import { createLogger, type LogFields } from "../src/utils/logger.js";

const encryptionKey = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

test("email token envelope is AES-GCM encrypted, authenticated, and uses no plaintext token", () => {
  const token = "one-time-secret-token-value";
  const encrypted = encryptEmailToken(token, encryptionKey);
  const [version, iv, tag, ciphertext] = encrypted.split(".");
  const tamperedTag = `${tag[0] === "0" ? "1" : "0"}${tag.slice(1)}`;
  assert.doesNotMatch(encrypted, new RegExp(token));
  assert.equal(decryptEmailToken(encrypted, encryptionKey), token);
  assert.throws(() => decryptEmailToken(encrypted, "f".repeat(64)));
  assert.throws(() => decryptEmailToken(`${version}.${iv}.${tamperedTag}.${ciphertext}`, encryptionKey));
  assert.throws(() => encryptEmailToken(token, "short"));
});

test("email queue payload stores an encrypted token, stable job ID, and correlation ID", async () => {
  let captured: { payload: EmailJobPayload; jobId: string } | undefined;
  const result = await enqueueAuthEmail({
    to: "private@example.test",
    template: "password-reset",
    token: "reset-secret-marker",
    tokenId: "auth-token-id",
  }, {
    encryptionKey,
    requestId: "request-email-123",
    add: async (payload, jobId) => { captured = { payload, jobId }; },
    log: { info() {}, warn() {}, error() {} },
  });

  assert.equal(result.jobId, "auth-email-auth-token-id");
  assert.equal(captured?.jobId, result.jobId);
  assert.equal(captured?.payload.to, "private@example.test");
  assert.equal(captured?.payload.template, "password-reset");
  assert.equal(captured?.payload.requestId, "request-email-123");
  assert.equal(decryptEmailToken(captured!.payload.encryptedToken, encryptionKey), "reset-secret-marker");
  assert.equal(JSON.stringify(captured).includes("reset-secret-marker"), false);
});

test("central email templates include one-time links in both HTML and text", () => {
  const verification = createAuthEmail("verify-email", "verification-token", {
    to: "user@example.test",
    from: "FleetFlow <no-reply@example.test>",
    appBaseUrl: "https://fleetflow.example.test",
  });
  assert.equal(verification.subject, "Verify your FleetFlow email");
  assert.match(verification.text, /https:\/\/fleetflow\.example\.test\/verify-email\?token=verification-token/);
  assert.match(verification.html, /href="https:\/\/fleetflow\.example\.test\/verify-email\?token=verification-token"/);

  const reset = createAuthEmail("password-reset", "reset-token", {
    to: "user@example.test",
    from: "no-reply@example.test",
    appBaseUrl: "https://fleetflow.example.test/app",
  });
  assert.match(reset.text, /\/reset-password\?token=reset-token/);
  assert.match(reset.html, /ignore this email/i);
});

test("console provider is explicit that development email is not delivered and does not reveal message content", async () => {
  const events: string[] = [];
  const log = {
    info: (_event: string, _fields?: LogFields) => undefined,
    warn: (event: string) => events.push(event),
    error: (_event: string, _fields?: LogFields) => undefined,
  };
  const provider = createEmailProvider({ provider: "console", log });
  const result = await provider.send({
    to: "private@example.test",
    from: "no-reply@example.test",
    subject: "Sensitive subject marker",
    text: "Sensitive token marker",
    html: "Sensitive token marker",
  });
  assert.deepEqual(result, { delivered: false, provider: "console" });
  assert.deepEqual(events, ["email_not_delivered_development_provider"]);
  assert.doesNotMatch(events.join(" "), /private@example|Sensitive/);
});

test("Resend adapter sends HTML and text and fails safely without exposing provider response bodies", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const provider = createEmailProvider({
    provider: "resend",
    apiKey: "private-api-key-marker",
    fetcher: async (input, init) => {
      request = { url: String(input), init };
      return new Response("{\"id\":\"provider-id\"}", { status: 200 });
    },
  });
  const message = {
    to: "private@example.test",
    from: "no-reply@example.test",
    subject: "Subject",
    text: "Plain text body",
    html: "<p>HTML body</p>",
  };
  assert.deepEqual(await provider.send(message), { delivered: true, provider: "resend" });
  assert.equal(request?.url, "https://api.resend.com/emails");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer private-api-key-marker");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), message);

  const failure = createEmailProvider({
    provider: "resend",
    apiKey: "private-api-key-marker",
    fetcher: async () => new Response("secret provider response", { status: 503 }),
  });
  await assert.rejects(failure.send(message), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /503/);
    assert.doesNotMatch(error.message, /secret provider response|private-api-key/);
    return true;
  });
  await assert.rejects(createEmailProvider({ provider: "resend" }).send(message), /EMAIL_API_KEY/);
});

test("logger sanitizer redacts recipient and email tokens from job fields", () => {
  const lines: string[] = [];
  const logger = createLogger("production", { log: (line) => lines.push(line) });
  logger("info", "email_job", {
    email: "private@example.test",
    token: "raw-token-marker",
    encryptedToken: "ciphertext-marker",
    template: "verify-email",
  });
  assert.equal(JSON.parse(lines[0]).template, "verify-email");
  assert.doesNotMatch(lines[0], /private@example|raw-token-marker|ciphertext-marker/);
});
