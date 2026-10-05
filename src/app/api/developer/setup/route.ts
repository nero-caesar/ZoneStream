import { NextRequest, NextResponse } from "next/server";
import { createDeveloperCredentials, createDeveloperSessionToken, DEVELOPER_SESSION_COOKIE, DEVELOPER_SESSION_IDLE_COOKIE, DEVELOPER_SESSION_IDLE_SECONDS, DEVELOPER_SESSION_MAX_AGE_SECONDS, getDeveloperCredentials, isLocalDeveloperSetupRequest } from "../../../../lib/auth/developer-space";
import { isSameOriginRequest } from "../../../../lib/auth/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please set up Developer Space from ZoneStream." }, { status: 403 });
  if (!isLocalDeveloperSetupRequest(request)) return NextResponse.json({ error: "The one-time owner password setup is only available from localhost." }, { status: 403 });

  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter a developer password to continue." }, { status: 400 });
  }
  if (typeof body.password !== "string" || body.password.length < 16 || Buffer.byteLength(body.password, "utf8") > 128) {
    return NextResponse.json({ error: "Choose a strong passphrase with at least 16 characters." }, { status: 400 });
  }

  try {
    const created = await createDeveloperCredentials(body.password);
    if (!created) return NextResponse.json({ error: "Developer Space has already been set up." }, { status: 409 });
    const credentials = await getDeveloperCredentials();
    if (!credentials) return NextResponse.json({ error: "Developer Space was saved, but sign-in could not start. Please reload and sign in." }, { status: 503 });

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
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ error: "We could not set up Developer Space right now. Please try again." }, { status: 503 });
  }
}
