import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function parseKey(keyHex: string): Buffer {
  if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) {
    throw new Error("EMAIL_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as 64 hexadecimal characters.");
  }
  return Buffer.from(keyHex, "hex");
}

export function encryptEmailToken(token: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, parseKey(keyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("hex")}.${tag.toString("hex")}.${ciphertext.toString("hex")}`;
}

export function decryptEmailToken(envelope: string, keyHex: string): string {
  const [version, ivHex, tagHex, ciphertextHex, extra] = envelope.split(".");
  if (
    version !== "v1" || extra !== undefined ||
    !/^[a-fA-F0-9]{24}$/.test(ivHex ?? "") ||
    !/^[a-fA-F0-9]{32}$/.test(tagHex ?? "") ||
    !/^[a-fA-F0-9]+$/.test(ciphertextHex ?? "")
  ) {
    throw new Error("Invalid encrypted email token envelope.");
  }

  const decipher = createDecipheriv(ALGORITHM, parseKey(keyHex), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
