import { NextRequest, NextResponse } from "next/server";
import { AUTH_SESSION_COOKIE, AUTH_SESSION_IDLE_COOKIE, AUTH_SESSION_REMEMBER_COOKIE, AUTH_SPECIAL_SESSION_COOKIE, getAccountProfile } from "../../../../lib/auth/session";
import { createAuthSessionResponse, getRequestAccount, isSameOriginRequest, verifyIdToken } from "../../../../lib/auth/server";
import { toPublicAccountProfile } from "../../../../lib/auth/public-profile";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { ZONAL_ACCOUNT_UID } from "../../../../lib/auth/zonal-password";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Please sign in from the ZoneStream website." }, { status: 403 });
  }

  let body: { idToken?: unknown; rememberMe?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please send a valid sign-in request." }, { status: 400 });
  }

  let claims: Awaited<ReturnType<typeof verifyIdToken>>;
  try {
    claims = await verifyIdToken(body.idToken);
  } catch (error) {
    const details = error && typeof error === "object"
      ? error as { name?: unknown; code?: unknown }
      : null;
    console.error("[ZoneStream auth] Sign-in token verifier unavailable", {
      name: typeof details?.name === "string" ? details.name : typeof error,
      code: typeof details?.code === "string" ? details.code : undefined,
    });
    return NextResponse.json({ error: "We couldn't verify your sign-in right now. Please try again later." }, { status: 503 });
  }
  if (!claims || typeof body.idToken !== "string") {
    return NextResponse.json({ error: "Your sign-in has expired. Please sign in again." }, { status: 401 });
  }

  try {
    const profile = await getAccountProfile(claims.uid);
    if (!profile) {
      return NextResponse.json({ error: "This account is not registered for ZoneStream yet." }, { status: 403 });
    }
    if (profile.role === "zonal" && profile.uid !== ZONAL_ACCOUNT_UID) {
      return NextResponse.json({ error: "This Zonal Church account is no longer active." }, { status: 403 });
    }
    if (profile.role === "zonal") {
      const access = await getFirebaseAdmin().firestore.collection("zonalAuth").doc("access").get();
      if (!access.exists || access.get("recoveryEnabled") !== true) {
        return NextResponse.json({ error: "The Zonal Church account is not ready yet." }, { status: 403 });
      }
    }

    if (profile.status !== "active") {
      return NextResponse.json({ error: profile.status === "pending" ? "This church account is awaiting Zonal Church approval." : "This account is not active. Contact the Zonal Church for help." }, { status: 403 });
    }

    const sessionResponse = await createAuthSessionResponse(
      body.idToken,
      profile,
      request.cookies.get(AUTH_SPECIAL_SESSION_COOKIE)?.value,
      body.rememberMe === true && profile.role === "individual",
    );
    await recordPlatformActivity({
      action: `${profile.role}_signed_in`,
      label: `${profile.displayName} signed in`,
      actorType: profile.role,
      actorName: profile.displayName,
      subjectId: profile.uid,
    });
    return sessionResponse;
  } catch (error) {
    const details = error && typeof error === "object"
      ? error as { name?: unknown; code?: unknown }
      : null;
    console.error("[ZoneStream auth] Session creation failed", {
      name: typeof details?.name === "string" ? details.name : typeof error,
      code: typeof details?.code === "string" ? details.code : undefined,
    });
    return NextResponse.json({ error: "We could not finish signing you in. Please try again." }, { status: 503 });
  }
}

export async function GET(request: NextRequest) {
  const account = await getRequestAccount(request);
  if (!account) return NextResponse.json({ authenticated: false }, { status: 401 });
  if (account.profile.role === "zonal") {
    if (account.profile.uid !== ZONAL_ACCOUNT_UID) return NextResponse.json({ authenticated: false }, { status: 401 });
    const access = await getFirebaseAdmin().firestore.collection("zonalAuth").doc("access").get();
    if (!access.exists || access.get("recoveryEnabled") !== true) return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({ authenticated: true, profile: toPublicAccountProfile(account.profile) });
}

export async function DELETE(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Please sign out from the ZoneStream website." }, { status: 403 });
  }

  const response = NextResponse.json({ signedOut: true });
  const sessionCookie = request.cookies.get(AUTH_SESSION_COOKIE)?.value;
  if (sessionCookie) {
    try {
      const { auth } = getFirebaseAdmin();
      const claims = await auth.verifySessionCookie(sessionCookie, true);
      if (claims.uid !== ZONAL_ACCOUNT_UID) await auth.revokeRefreshTokens(claims.uid);
    } catch {
      // Clear a stale or already-revoked session cookie regardless.
    }
  }
  response.cookies.set(AUTH_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set(AUTH_SESSION_IDLE_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set(AUTH_SESSION_REMEMBER_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set(AUTH_SPECIAL_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
