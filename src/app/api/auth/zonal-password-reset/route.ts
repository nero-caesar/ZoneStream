import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import {
  createZonalResetRequest,
  readZonalResetRequest,
  ZONAL_RESET_REQUEST_COOKIE,
  ZONAL_RESET_REQUEST_LIFETIME_MS,
} from "../../../../lib/auth/zonal-reset-requests";

export const runtime = "nodejs";

function jsonNoStore(body: object, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return jsonNoStore({ error: "Please request studio recovery from ZoneStream." }, 403);

  try {
    const result = await createZonalResetRequest();
    if (!result.ok) {
      if (result.reason === "not-ready") {
        return jsonNoStore({ error: "Studio password recovery is not ready yet. Please try again later." }, 409);
      }
      const response = jsonNoStore({ error: "A studio reset was requested recently. Please wait a few minutes before trying again." }, 429);
      response.headers.set("Retry-After", String(result.retryAfterSeconds));
      return response;
    }

    const response = jsonNoStore({
      message: "Your request is waiting for approval in Developer Space. A reset link will be emailed after approval.",
    });
    response.cookies.set(ZONAL_RESET_REQUEST_COOKIE, result.cookieValue, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/auth/zonal-password-reset",
      maxAge: Math.floor(ZONAL_RESET_REQUEST_LIFETIME_MS / 1000),
    });
    return response;
  } catch {
    return jsonNoStore({ error: "ZoneStream could not save the request right now. Please try again." }, 503);
  }
}

export async function GET(request: NextRequest) {
  try {
    const status = await readZonalResetRequest(request);
    const response = jsonNoStore(status);
    if (["delivered", "rejected", "expired"].includes(status.status)) {
      response.cookies.set(ZONAL_RESET_REQUEST_COOKIE, "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/api/auth/zonal-password-reset",
        maxAge: 0,
      });
    }
    return response;
  } catch {
    return jsonNoStore({ status: "unavailable", error: "We could not check your studio reset request right now." }, 503);
  }
}
