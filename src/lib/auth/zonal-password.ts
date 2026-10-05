import "server-only";

import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { getFirebaseAdmin } from "../firebase/admin";

export const ZONAL_ACCOUNT_UID = "zonestream-zonal-church";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 8;

export function isLocalZonalSetupRequest(request: NextRequest): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  const hostname = request.nextUrl.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function loginAttemptRef(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientAddress = forwardedFor || request.headers.get("x-real-ip")?.trim() || "unknown";
  const key = createHash("sha256").update(clientAddress).digest("hex");
  return getFirebaseAdmin().firestore.collection("zonalLoginAttempts").doc(key);
}

export async function isZonalLoginRateLimited(request: NextRequest): Promise<boolean> {
  const snapshot = await loginAttemptRef(request).get();
  if (!snapshot.exists) return false;
  const record = snapshot.data() ?? {};
  const windowStartedAt = Number(record.windowStartedAt);
  if (!Number.isFinite(windowStartedAt) || Date.now() - windowStartedAt >= LOGIN_WINDOW_MS) return false;
  return Number(record.failedAttempts) >= LOGIN_ATTEMPT_LIMIT;
}

export async function recordZonalLoginFailure(request: NextRequest): Promise<void> {
  const { firestore } = getFirebaseAdmin();
  const ref = loginAttemptRef(request);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const record = snapshot.data() ?? {};
    const windowStartedAt = Number(record.windowStartedAt);
    const isExpired = !Number.isFinite(windowStartedAt) || Date.now() - windowStartedAt >= LOGIN_WINDOW_MS;
    transaction.set(ref, {
      windowStartedAt: isExpired ? Date.now() : windowStartedAt,
      failedAttempts: isExpired ? 1 : Number(record.failedAttempts || 0) + 1,
    });
  });
}

export async function clearZonalLoginFailures(request: NextRequest): Promise<void> {
  await loginAttemptRef(request).delete().catch(() => undefined);
}
