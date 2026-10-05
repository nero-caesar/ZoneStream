import { NextRequest, NextResponse } from "next/server";
import { createAuthSessionResponse, isSameOriginRequest } from "../../../../lib/auth/server";
import {
  clearZonalLoginFailures,
  isZonalLoginRateLimited,
  recordZonalLoginFailure,
  ZONAL_ACCOUNT_UID,
} from "../../../../lib/auth/zonal-password";
import { AUTH_SPECIAL_SESSION_COOKIE, getAccountProfile } from "../../../../lib/auth/session";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";

export const runtime = "nodejs";

type FirebaseSignInResult = {
  idToken?: unknown;
  localId?: unknown;
  error?: { message?: unknown };
};

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Please sign in from ZoneStream." }, { status: 403 });
  }

  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please enter the Zonal Church password." }, { status: 400 });
  }
  if (typeof body.password !== "string" || body.password.length < 14 || body.password.length > 128) {
    return NextResponse.json({ error: "Enter the shared Zonal Church password." }, { status: 401 });
  }

  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Studio sign-in is not ready right now. Please try again later." }, { status: 503 });
  }

  try {
    if (await isZonalLoginRateLimited(request)) {
      return NextResponse.json({ error: "Too many incorrect attempts. Try again in 15 minutes." }, { status: 429 });
    }

    const { auth, firestore } = getFirebaseAdmin();
    const access = await firestore.collection("zonalAuth").doc("access").get();
    if (!access.exists || access.get("recoveryEnabled") !== true) {
      return NextResponse.json({ error: "Complete the one-time Zonal Church password setup first." }, { status: 409 });
    }
    const zonalAuthEmail = (await auth.getUser(ZONAL_ACCOUNT_UID)).email;
    if (!zonalAuthEmail) return NextResponse.json({ error: "The Zonal Church sign-in is not ready. Contact the platform owner." }, { status: 503 });

    const firebaseResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: zonalAuthEmail, password: body.password, returnSecureToken: true }),
      cache: "no-store",
    });
    const result = await firebaseResponse.json() as FirebaseSignInResult;
    if (!firebaseResponse.ok || typeof result.idToken !== "string" || result.localId !== ZONAL_ACCOUNT_UID) {
      const firebaseCode = typeof result.error?.message === "string" ? result.error.message : "";
      if (firebaseResponse.status < 500 && firebaseCode !== "API_KEY_INVALID" && firebaseCode !== "PROJECT_NOT_FOUND") {
        await recordZonalLoginFailure(request);
        return NextResponse.json({ error: "The Zonal Church password is incorrect." }, { status: 401 });
      }
      console.error("[ZoneStream auth] Firebase rejected the Zonal sign-in request", {
        status: firebaseResponse.status,
        code: firebaseCode || "unknown",
      });
      return NextResponse.json({ error: "We could not sign in to the Zonal Church account. Please try again." }, { status: 503 });
    }

    const claims = await auth.verifyIdToken(result.idToken, true);
    if (claims.uid !== ZONAL_ACCOUNT_UID) {
      await recordZonalLoginFailure(request);
      return NextResponse.json({ error: "The Zonal Church password is incorrect." }, { status: 401 });
    }

    const profile = await getAccountProfile(ZONAL_ACCOUNT_UID);
    if (!profile || profile.role !== "zonal" || profile.status !== "active") {
      return NextResponse.json({ error: "The Zonal Church account is not active." }, { status: 403 });
    }

    await clearZonalLoginFailures(request);
    const response = await createAuthSessionResponse(
      result.idToken,
      profile,
      request.cookies.get(AUTH_SPECIAL_SESSION_COOKIE)?.value,
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    const details = error && typeof error === "object"
      ? error as { name?: unknown; code?: unknown }
      : null;
    console.error("[ZoneStream auth] Zonal sign-in failed", {
      name: typeof details?.name === "string" ? details.name : typeof error,
      code: typeof details?.code === "string" ? details.code : undefined,
    });
    return NextResponse.json({ error: "We could not sign in to the Zonal Church account. Please try again." }, { status: 503 });
  }
}
