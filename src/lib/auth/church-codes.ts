import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from "node:crypto";

function codeSecret(): string {
  const secret = process.env.FIREBASE_CHURCH_CODE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Set FIREBASE_CHURCH_CODE_SECRET to a random value of at least 32 characters.");
  }
  return secret;
}

export function generateChurchCode(): string {
  return randomInt(0, 10_000_000_000).toString().padStart(10, "0");
}

export function hashChurchCode(code: string): string {
  return createHmac("sha256", codeSecret()).update(code).digest("hex");
}

function encryptionKey(): Buffer {
  return createHmac("sha256", codeSecret()).update("ZoneStream church code encryption").digest();
}

export function encryptChurchCode(code: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const encrypted = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptChurchCode(value: string): string | null {
  try {
    const [nonceValue, tagValue, encryptedValue] = value.split(".");
    if (!nonceValue || !tagValue || !encryptedValue) return null;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(nonceValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
