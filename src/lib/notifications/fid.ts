import { createHash } from "node:crypto";

export function isValidFirebaseInstallationId(fid: unknown): fid is string {
  return typeof fid === "string" && /^[A-Za-z0-9_-]{10,128}$/.test(fid);
}

export function getFirebaseInstallationDocumentId(fid: string): string {
  return createHash("sha256").update(fid).digest("hex");
}
