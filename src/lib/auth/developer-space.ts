import "server-only";

import { createHmac, createHash, randomBytes, timingSafeEqual, scryptSync } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getFirebaseAdmin } from "../firebase/admin";

export const DEVELOPER_SESSION_COOKIE = "zonestream_developer_session";
export const DEVELOPER_SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;
export const DEVELOPER_SESSION_IDLE_COOKIE = "zonestream_developer_last_activity";
export const DEVELOPER_SESSION_IDLE_SECONDS = 30 * 60;
const CREDENTIALS_PATH = ["developerSpace", "access"] as const;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 8;

type DeveloperCredentials = {
  passwordSalt: string;
  passwordHash: string;
  sessionSecret: string;
};

function getCredentialRef() {
  const { firestore } = getFirebaseAdmin();
  return firestore.collection(CREDENTIALS_PATH[0]).doc(CREDENTIALS_PATH[1]);
}

export async function getDeveloperCredentials(): Promise<DeveloperCredentials | null> {
  const snapshot = await getCredentialRef().get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (
    typeof data?.passwordSalt !== "string" ||
    typeof data.passwordHash !== "string" ||
    typeof data.sessionSecret !== "string"
  ) return null;
  return {
    passwordSalt: data.passwordSalt,
    passwordHash: data.passwordHash,
    sessionSecret: data.sessionSecret,
  };
}

export function hashDeveloperPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}

export function secureStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function createDeveloperCredentials(password: string): Promise<boolean> {
  const ref = getCredentialRef();
  const passwordSalt = randomBytes(16).toString("hex");
  const credentials = {
    passwordSalt,
    passwordHash: hashDeveloperPassword(password, passwordSalt),
    sessionSecret: randomBytes(32).toString("base64url"),
    createdAt: new Date().toISOString(),
  };

  return getFirebaseAdmin().firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    if (current.exists) return false;
    transaction.create(ref, credentials);
    return true;
  });
}

function sessionSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update("zonestream-developer-session:").update(payload).digest("base64url");
}

export function createDeveloperSessionToken(credentials: DeveloperCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ issuedAt: now, expiresAt: now + DEVELOPER_SESSION_MAX_AGE_SECONDS, nonce: randomBytes(18).toString("base64url") })).toString("base64url");
  return `${payload}.${sessionSignature(payload, credentials.sessionSecret)}`;
}

export async function verifyDeveloperSession(token: string | undefined, lastActivity?: string): Promise<boolean> {
  if (!token || token.length > 1024) return false;
  if (!lastActivity || !/^\d{10,16}$/.test(lastActivity) || !Number.isSafeInteger(Number(lastActivity)) || Number(lastActivity) > Date.now() || Date.now() - Number(lastActivity) > DEVELOPER_SESSION_IDLE_SECONDS * 1000) return false;
  const [payload, providedSignature, ...rest] = token.split(".");
  if (!payload || !providedSignature || rest.length) return false;

  try {
    const credentials = await getDeveloperCredentials();
    if (!credentials) return false;
    const expectedSignature = sessionSignature(payload, credentials.sessionSecret);
    if (!secureStringEqual(providedSignature, expectedSignature)) return false;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { issuedAt?: unknown; expiresAt?: unknown; nonce?: unknown };
    const now = Math.floor(Date.now() / 1000);
    return Number.isInteger(session.issuedAt) && Number.isInteger(session.expiresAt) &&
      Number(session.issuedAt) <= now && Number(session.expiresAt) > now &&
      typeof session.nonce === "string";
  } catch {
    return false;
  }
}

export async function verifyDeveloperRequest(request: NextRequest): Promise<boolean> {
  return verifyDeveloperSession(
    request.cookies.get(DEVELOPER_SESSION_COOKIE)?.value,
    request.cookies.get(DEVELOPER_SESSION_IDLE_COOKIE)?.value,
  );
}

export async function getDeveloperPageSession(): Promise<boolean> {
  const cookieStore = await cookies();
  return verifyDeveloperSession(
    cookieStore.get(DEVELOPER_SESSION_COOKIE)?.value,
    cookieStore.get(DEVELOPER_SESSION_IDLE_COOKIE)?.value,
  );
}

export function isLocalDeveloperSetupRequest(request: NextRequest): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  const hostname = request.nextUrl.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function loginAttemptRef(request: NextRequest) {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown-client";
  const hashedAddress = createHash("sha256").update(address).digest("hex");
  return getFirebaseAdmin().firestore.collection("developerLoginAttempts").doc(hashedAddress);
}

export async function isDeveloperLoginRateLimited(request: NextRequest): Promise<boolean> {
  const snapshot = await loginAttemptRef(request).get();
  if (!snapshot.exists) return false;
  const startedAt = Number(snapshot.get("windowStartedAt"));
  return Number.isFinite(startedAt) && Date.now() - startedAt < LOGIN_WINDOW_MS &&
    Number(snapshot.get("failedAttempts")) >= LOGIN_ATTEMPT_LIMIT;
}

export async function recordDeveloperLoginFailure(request: NextRequest): Promise<void> {
  const { firestore } = getFirebaseAdmin();
  const ref = loginAttemptRef(request);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const startedAt = Number(snapshot.get("windowStartedAt"));
    const expired = !Number.isFinite(startedAt) || Date.now() - startedAt >= LOGIN_WINDOW_MS;
    transaction.set(ref, {
      windowStartedAt: expired ? Date.now() : startedAt,
      failedAttempts: expired ? 1 : Number(snapshot.get("failedAttempts") || 0) + 1,
    });
  });
}

export async function clearDeveloperLoginFailures(request: NextRequest): Promise<void> {
  await loginAttemptRef(request).delete().catch(() => undefined);
}
