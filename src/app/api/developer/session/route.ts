import { NextRequest, NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { clearDeveloperLoginFailures, createDeveloperSessionToken, DEVELOPER_SESSION_COOKIE, DEVELOPER_SESSION_IDLE_COOKIE, DEVELOPER_SESSION_IDLE_SECONDS, DEVELOPER_SESSION_MAX_AGE_SECONDS, getDeveloperCredentials, hashDeveloperPassword, isDeveloperLoginRateLimited, recordDeveloperLoginFailure, secureStringEqual, verifyDeveloperRequest } from "../../../../lib/auth/developer-space";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authenticated = await verifyDeveloperRequest(request);
  const response = NextResponse.json({ authenticated }, { status: authenticated ? 200 : 401 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please sign in from ZoneStream." }, { status: 403 });
  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter your developer password." }, { status: 400 });
  }
  if (typeof body.password !== "string" || body.password.length > 128) {
    return NextResponse.json({ error: "The developer password is incorrect." }, { status: 401 });
  }

  try {
    if (await isDeveloperLoginRateLimited(request)) {
      return NextResponse.json({ error: "Too many incorrect attempts. Try again in 15 minutes." }, { status: 429 });
    }
    const credentials = await getDeveloperCredentials();
    if (!credentials || !secureStringEqual(hashDeveloperPassword(body.password, credentials.passwordSalt), credentials.passwordHash)) {
      await recordDeveloperLoginFailure(request);
      return NextResponse.json({ error: "The developer password is incorrect." }, { status: 401 });
    }
    await clearDeveloperLoginFailures(request);
    const response = NextResponse.json({ authenticated: true });
    response.cookies.set(DEVELOPER_SESSION_COOKIE, createDeveloperSessionToken(credentials), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: DEVELOPER_SESSION_MAX_AGE_SECONDS,
    });
    response.cookies.set(DEVELOPER_SESSION_IDLE_COOKIE, String(Date.now()), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: DEVELOPER_SESSION_IDLE_SECONDS,
    });
    await recordPlatformActivity({ action: "developer_signed_in", label: "ZoneStream Developer signed in to Developer Space", actorType: "developer", actorName: "ZoneStream Developer" });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ error: "Developer Space could not verify access right now. Please try again." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please sign out from ZoneStream." }, { status: 403 });
  if (await verifyDeveloperRequest(request)) {
    await recordPlatformActivity({ action: "developer_signed_out", label: "ZoneStream Developer signed out of Developer Space", actorType: "developer", actorName: "ZoneStream Developer" });
    try {
      const { firestore } = getFirebaseAdmin();
      const currentProgram = (await firestore.collection("programs").doc("current").get()).data();
      const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
      if (currentProgram && typeof currentProgram.roomName === "string" && LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
        const service = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
        const participants = await service.listParticipants(currentProgram.roomName);
        await Promise.allSettled(participants.filter((participant) => participant.identity.startsWith("developer-preview-")).map((participant) => service.removeParticipant(currentProgram.roomName as string, participant.identity)));
      }
    } catch {
      // The owner session is still cleared even if LiveKit cannot be reached.
    }
  }
  const response = NextResponse.json({ signedOut: true });
  response.cookies.set(DEVELOPER_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set(DEVELOPER_SESSION_IDLE_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
