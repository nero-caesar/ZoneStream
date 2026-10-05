import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { sendEmailJsTemplate } from "../../../../lib/email/emailjs";
import { ZONAL_ACCOUNT_UID } from "../../../../lib/auth/zonal-password";

export const runtime = "nodejs";
const RESET_COOLDOWN_MS = 5 * 60 * 1000;

function jsonNoStore(body: object, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return jsonNoStore({ error: "Please request studio recovery from ZoneStream." }, 403);

  const now = Date.now();
  try {
    const { auth, firestore } = getFirebaseAdmin();
    const accessRef = firestore.collection("zonalAuth").doc("access");
    const reservation = await firestore.runTransaction(async (transaction) => {
      const access = await transaction.get(accessRef);
      if (!access.exists || access.get("recoveryEnabled") !== true) return { ok: false as const, reason: "not-ready" as const };
      const previous = Number(access.get("lastRecoveryRequestAt") ?? 0);
      if (Number.isFinite(previous) && now - previous < RESET_COOLDOWN_MS) {
        return { ok: false as const, reason: "cooldown" as const, retryAfterSeconds: Math.ceil((RESET_COOLDOWN_MS - (now - previous)) / 1000) };
      }
      transaction.update(accessRef, { lastRecoveryRequestAt: now });
      return { ok: true as const };
    });

    if (!reservation.ok) {
      if (reservation.reason === "not-ready") return jsonNoStore({ error: "Studio password recovery is not ready yet. Please try again later." }, 409);
      const response = jsonNoStore({ error: "A reset link was requested recently. Please wait a few minutes before trying again." }, 429);
      response.headers.set("Retry-After", String(reservation.retryAfterSeconds));
      return response;
    }

    const zonalUser = await auth.getUser(ZONAL_ACCOUNT_UID);
    if (!zonalUser.email) {
      await accessRef.update({ lastRecoveryRequestAt: 0 }).catch(() => undefined);
      return jsonNoStore({ error: "Studio recovery is not configured. Please contact the platform owner." }, 503);
    }
    const recoveryEmail = process.env.ZONAL_RECOVERY_EMAIL?.trim().toLowerCase() || "nzehoko388@gmail.com";
    const resetLink = await auth.generatePasswordResetLink(zonalUser.email);
    try {
      await sendEmailJsTemplate({ toEmail: recoveryEmail, appName: "ZoneStream", resetLink });
    } catch {
      await accessRef.update({ lastRecoveryRequestAt: 0 }).catch(() => undefined);
      return jsonNoStore({ error: "The reset link could not be emailed. Please try again later." }, 503);
    }
    return jsonNoStore({ message: `A password reset link has been sent to ${recoveryEmail}. Check your inbox and spam folder.` });
  } catch {
    return jsonNoStore({ error: "ZoneStream could not save the request right now. Please try again." }, 503);
  }
}
