import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { AccountProfile } from "./types";
import { toPublicAccountProfile } from "./public-profile";
import { AUTH_SESSION_COOKIE, AUTH_SESSION_IDLE_COOKIE, AUTH_SESSION_REMEMBER_COOKIE, AUTH_SESSION_STANDARD_SECONDS, AUTH_SESSION_MAX_AGE_SECONDS, AUTH_SPECIAL_SESSION_COOKIE, AUTH_SPECIAL_SESSION_MAX_AGE_SECONDS, getAccountProfile, getAuthIdleTimeout, isActivityCookieFresh, verifyFirebaseSession } from "./session";
import { getFirebaseAdmin } from "../firebase/admin";
import { ZONAL_ACCOUNT_UID } from "./zonal-password";

export function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;

  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export async function verifyIdToken(idToken: unknown) {
  if (typeof idToken !== "string" || idToken.length < 20) return null;
  try {
    const { auth } = getFirebaseAdmin();
    return await auth.verifyIdToken(idToken, true);
  } catch {
    return null;
  }
}

export async function createAuthSessionResponse(idToken: string, profile: AccountProfile, existingSpecialSession?: string, rememberMe = false) {
  const { auth } = getFirebaseAdmin();
  const sessionLifetime = rememberMe ? AUTH_SESSION_MAX_AGE_SECONDS : AUTH_SESSION_STANDARD_SECONDS;
  const sessionCookie = await auth.createSessionCookie(idToken, {
    expiresIn: sessionLifetime * 1000,
  });
  const response = NextResponse.json({ profile: toPublicAccountProfile(profile) });
  response.cookies.set(AUTH_SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    ...(rememberMe ? { maxAge: sessionLifetime } : {}),
  });
  response.cookies.set(AUTH_SESSION_IDLE_COOKIE, String(Date.now()), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: getAuthIdleTimeout(rememberMe),
  });
  if (rememberMe) {
    response.cookies.set(AUTH_SESSION_REMEMBER_COOKIE, "1", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
    });
  } else {
    response.cookies.set(AUTH_SESSION_REMEMBER_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  const specialSession = existingSpecialSession && /^[A-Za-z0-9_-]{40,60}$/.test(existingSpecialSession)
    ? existingSpecialSession
    : randomBytes(32).toString("base64url");
  response.cookies.set(AUTH_SPECIAL_SESSION_COOKIE, specialSession, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_SPECIAL_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}

export async function getRequestAccount(request: NextRequest) {
  const sessionCookie = request.cookies.get(AUTH_SESSION_COOKIE)?.value;
  if (!sessionCookie) return null;
  const rememberMe = request.cookies.get(AUTH_SESSION_REMEMBER_COOKIE)?.value === "1";
  const lastActivity = request.cookies.get(AUTH_SESSION_IDLE_COOKIE)?.value;
  if (!isActivityCookieFresh(lastActivity, getAuthIdleTimeout(rememberMe))) return null;

  try {
    const claims = await verifyFirebaseSession(sessionCookie);
    const profile = await getAccountProfile(claims.uid);
    return profile?.status === "active" ? { claims, profile } : null;
  } catch {
    return null;
  }
}

export function refreshAuthActivity(request: NextRequest) {
  const rememberMe = request.cookies.get(AUTH_SESSION_REMEMBER_COOKIE)?.value === "1";
  const timeoutSeconds = getAuthIdleTimeout(rememberMe);
  const previousActivity = request.cookies.get(AUTH_SESSION_IDLE_COOKIE)?.value;
  if (!isActivityCookieFresh(previousActivity, timeoutSeconds)) return null;
  const response = NextResponse.json({ authenticated: true, idleTimeoutSeconds: timeoutSeconds });
  response.cookies.set(AUTH_SESSION_IDLE_COOKIE, String(Date.now()), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: timeoutSeconds,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function requireZonalAccount(request: NextRequest) {
  const account = await getRequestAccount(request);
  if (
    account?.profile.role !== "zonal" ||
    account.profile.uid !== ZONAL_ACCOUNT_UID ||
    account.profile.status !== "active"
  ) return null;

  try {
    const access = await getFirebaseAdmin().firestore.collection("zonalAuth").doc("access").get();
    return access.exists && access.get("recoveryEnabled") === true ? account : null;
  } catch {
    return null;
  }
}
