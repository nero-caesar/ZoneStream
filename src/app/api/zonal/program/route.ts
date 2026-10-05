import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please start a service from ZoneStream." }, { status: 403 });
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to start a service." }, { status: 403 });

  let body: { roomName?: unknown; title?: unknown; shareUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please enter a program title." }, { status: 400 });
  }

  if (
    typeof body.roomName !== "string" || !/^[a-z0-9][a-z0-9-]{5,79}$/i.test(body.roomName) ||
    typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 90 ||
    typeof body.shareUrl !== "string" || body.shareUrl.length > 500
  ) {
    return NextResponse.json({ error: "Enter a valid program title and live link." }, { status: 400 });
  }

  try {
    const shareUrl = new URL(body.shareUrl);
    if (shareUrl.origin !== request.nextUrl.origin || shareUrl.pathname !== `/stream/watch/${body.roomName}`) {
      return NextResponse.json({ error: "The live-service link must belong to this ZoneStream site." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Enter a valid live-service link." }, { status: 400 });
  }

  try {
    const { firestore } = getFirebaseAdmin();
    await firestore.collection("programs").doc("current").set({
      roomName: body.roomName,
      title: body.title.trim(),
      shareUrl: body.shareUrl,
      startedAt: new Date().toISOString(),
      startedBy: operator.uid,
      startedByType: operator.kind,
    });
    await recordPlatformActivity({ action: "service_started", label: `${operator.displayName} started a live service: ${body.title.trim()}`, actorType: operator.kind, actorName: operator.displayName, subjectName: body.title.trim(), roomName: body.roomName });
    return NextResponse.json({ registered: true });
  } catch {
    return NextResponse.json({ error: "We could not save the live service details." }, { status: 503 });
  }
}
