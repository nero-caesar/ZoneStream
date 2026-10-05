import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../../lib/auth/server";
import { verifyDeveloperRequest } from "../../../../../lib/auth/developer-space";
import { decideZonalResetRequest } from "../../../../../lib/auth/zonal-reset-requests";
import { getFirebaseAdmin } from "../../../../../lib/firebase/admin";
import { recordPlatformActivity } from "../../../../../lib/audit/platform-activity";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ requestId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please review reset requests from Developer Space." }, { status: 403 });
  if (!await verifyDeveloperRequest(request)) return NextResponse.json({ error: "Sign in to Developer Space." }, { status: 401 });

  let body: { decision?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Choose approve or reject." }, { status: 400 });
  }
  if (body.decision !== "approve" && body.decision !== "reject") return NextResponse.json({ error: "Choose approve or reject." }, { status: 400 });
  const { requestId } = await context.params;

  try {
    const decision = await decideZonalResetRequest(requestId, body.decision === "approve");
    if (!decision.ok) {
      if (decision.status === "delivery-failed") {
        return NextResponse.json({ error: decision.message || "The reset link could not be emailed. Check EmailJS settings and retry." }, { status: 503 });
      }
      const message = decision.status === "expired" ? "That request expired before it was reviewed." : "That reset request is no longer waiting for a decision.";
      return NextResponse.json({ error: message }, { status: decision.status === "missing" ? 404 : 409 });
    }
    await getFirebaseAdmin().firestore.collection("developerAuditLog").add({
      action: body.decision === "approve" ? "studio_reset_approved" : "studio_reset_rejected",
      requestId,
      at: new Date().toISOString(),
    });
    await recordPlatformActivity({
      action: body.decision === "approve" ? "studio_reset_approved" : "studio_reset_rejected",
      label: body.decision === "approve" ? "Developer Space approved and emailed a Zonal Studio password reset link" : "Developer Space declined a Zonal Studio password reset",
      actorType: "developer",
      actorName: "ZoneStream Developer",
    });
    return NextResponse.json({ status: decision.status }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "The reset request could not be reviewed right now. Please try again." }, { status: 503 });
  }
}
