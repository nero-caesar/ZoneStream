import { NextRequest, NextResponse } from "next/server";
import { DEVELOPER_SESSION_IDLE_COOKIE, DEVELOPER_SESSION_IDLE_SECONDS, verifyDeveloperRequest } from "../../../../lib/auth/developer-space";
import { isSameOriginRequest } from "../../../../lib/auth/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "This request could not be completed." }, { status: 403 });
  if (!await verifyDeveloperRequest(request)) return NextResponse.json({ authenticated: false }, { status: 401 });
  const response = NextResponse.json({ authenticated: true, idleTimeoutSeconds: DEVELOPER_SESSION_IDLE_SECONDS });
  response.cookies.set(DEVELOPER_SESSION_IDLE_COOKIE, String(Date.now()), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: DEVELOPER_SESSION_IDLE_SECONDS,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
