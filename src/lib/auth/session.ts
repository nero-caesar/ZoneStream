import "server-only";

import { cookies } from "next/headers";
import type { DecodedIdToken } from "firebase-admin/auth";
import type { AccountProfile } from "./types";
import { getFirebaseAdmin } from "../firebase/admin";
import { ZONAL_ACCOUNT_UID } from "./zonal-password";

export const AUTH_SESSION_COOKIE = "zonestream_session";
export const AUTH_SPECIAL_SESSION_COOKIE = "zonestream_special_session";
export const AUTH_SESSION_IDLE_COOKIE = "zonestream_session_last_activity";
export const AUTH_SESSION_REMEMBER_COOKIE = "zonestream_session_remember";
export const AUTH_SESSION_IDLE_SECONDS = 30 * 60;
export const AUTH_SESSION_REMEMBER_IDLE_SECONDS = 60 * 60 * 24 * 14;
export const AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;
export const AUTH_SESSION_STANDARD_SECONDS = 60 * 60 * 12;
export const AUTH_SPECIAL_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function getAuthIdleTimeout(rememberMe: boolean): number {
  return rememberMe ? AUTH_SESSION_REMEMBER_IDLE_SECONDS : AUTH_SESSION_IDLE_SECONDS;
}

export function isActivityCookieFresh(value: string | undefined, timeoutSeconds: number): boolean {
  if (!value || !/^\d{10,16}$/.test(value)) return false;
  const lastActivity = Number(value);
  return Number.isSafeInteger(lastActivity) && lastActivity <= Date.now() && Date.now() - lastActivity <= timeoutSeconds * 1000;
}

export async function verifyFirebaseSession(sessionCookie: string, checkRevoked = true): Promise<DecodedIdToken> {
  const { auth } = getFirebaseAdmin();
  return auth.verifySessionCookie(sessionCookie, checkRevoked);
}

export async function getAccountProfile(uid: string): Promise<AccountProfile | null> {
  const { firestore } = getFirebaseAdmin();
  const snapshot = await firestore.collection("accounts").doc(uid).get();
  if (!snapshot.exists) return null;
  return { uid, ...(snapshot.data() as Omit<AccountProfile, "uid">) };
}

export async function getCurrentAccount() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(AUTH_SESSION_COOKIE)?.value;
  if (!sessionCookie) return null;
  const rememberMe = cookieStore.get(AUTH_SESSION_REMEMBER_COOKIE)?.value === "1";
  const lastActivity = cookieStore.get(AUTH_SESSION_IDLE_COOKIE)?.value;
  if (!isActivityCookieFresh(lastActivity, getAuthIdleTimeout(rememberMe))) return null;

  try {
    const claims = await verifyFirebaseSession(sessionCookie);
    const profile = await getAccountProfile(claims.uid);
    if (!profile || profile.status !== "active") return null;
    if (profile?.role === "zonal") {
      if (profile.uid !== ZONAL_ACCOUNT_UID) return null;
      const access = await getFirebaseAdmin().firestore.collection("zonalAuth").doc("access").get();
      if (!access.exists || access.get("recoveryEnabled") !== true) return null;
    }
    return { claims, profile };
  } catch {
    return null;
  }
}
