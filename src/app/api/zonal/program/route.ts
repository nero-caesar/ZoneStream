import { RoomServiceClient } from "livekit-server-sdk";
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

  const programTitle = body.title.trim();

  try {
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return NextResponse.json({ error: "The streaming service is not ready yet. Please try again shortly." }, { status: 503 });
    }

    const { firestore } = getFirebaseAdmin();
    const programRef = firestore.collection("programs").doc("current");
    const previousProgram = await programRef.get();
    const expectedPreviousUpdate = previousProgram.updateTime?.toMillis() ?? null;

    if (previousProgram.exists) {
      const previousRoomName = previousProgram.get("roomName");
      if (typeof previousRoomName === "string") {
        const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
        const [activeRoom] = await roomService.listRooms([previousRoomName]);
        if (activeRoom) {
          return NextResponse.json({ error: "A live service is already running in another Studio tab. Return to that tab or end the service before starting another." }, { status: 409 });
        }

        const previousStartedAt = previousProgram.get("startedAt");
        const startedAtMs = typeof previousStartedAt === "string" ? Date.parse(previousStartedAt) : Number.NaN;
        const startIsStillPending = !Number.isFinite(startedAtMs) || Date.now() - startedAtMs < 120_000;
        if (startIsStillPending) {
          return NextResponse.json({ error: "Another Studio tab is preparing a live service. Wait a moment, then try again if it does not appear." }, { status: 409 });
        }
      }
    }

    const startedAt = new Date().toISOString();
    const started = await firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(programRef);
      const currentUpdate = current.updateTime?.toMillis() ?? null;
      if (currentUpdate !== expectedPreviousUpdate) return false;

      transaction.set(programRef, {
        roomName: body.roomName,
        title: programTitle,
        shareUrl: body.shareUrl,
        startedAt,
        startedBy: operator.uid,
        startedByType: operator.kind,
      });
      return true;
    });
    if (!started) {
      return NextResponse.json({ error: "Another Studio tab just started a live service. Return to that tab or end its service before starting another." }, { status: 409 });
    }

    await recordPlatformActivity({ action: "service_started", label: `${operator.displayName} started a live service: ${programTitle}`, actorType: operator.kind, actorName: operator.displayName, subjectName: programTitle, roomName: body.roomName });
    return NextResponse.json({ registered: true });
  } catch {
    return NextResponse.json({ error: "We could not check or save the live service details. Please try again." }, { status: 503 });
  }
}
