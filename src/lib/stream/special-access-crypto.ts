import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function encryptionKey(secret: string): Buffer {
  return createHash("sha256").update("ZoneStream special code display:").update(secret).digest();
}

export function hashSpecialAccessCode(code: string, secret: string): string {
  return createHmac("sha256", secret).update(code.trim().toUpperCase()).digest("hex");
}

export function hashChurchAccessKey(uid: string, secret: string): string {
  return createHmac("sha256", secret).update("zonal-church-access:").update(uid).digest("hex");
}

export function matchesSpecialAccessCode(code: string, expectedHash: string, secret: string): boolean {
  const actual = Buffer.from(hashSpecialAccessCode(code, secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function encryptSpecialAccessCode(code: string, secret: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), nonce);
  const encrypted = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptSpecialAccessCode(value: string, secret: string): string | null {
  try {
    const [nonceValue, tagValue, encryptedValue] = value.split(".");
    if (!nonceValue || !tagValue || !encryptedValue) return null;

    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(nonceValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export function encryptPrivateSpecialAccessState(state: unknown, secret: string): string {
  const serialized = JSON.stringify(state);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), nonce);
  const encrypted = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptPrivateSpecialAccessState(value: string, secret: string): unknown {
  try {
    const [nonceValue, tagValue, encryptedValue] = value.split(".");
    if (!nonceValue || !tagValue || !encryptedValue) return null;

    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(nonceValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const serialized = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
}
