import { RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { sendIndividualNotification } from "../../../../lib/notifications/send";
import { parsePublicStreamAccessPolicy } from "../../../../lib/stream/access-policy";

export const runtime = "nodejs";

type NotificationEventRequest = { event?: unknown; roomName?: unknown };

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please use the ZoneStream studio." }, { status: 403 });
  if (!await getStudioOperator(request)) return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to send live notifications." }, { status: 403 });

  let body: NotificationEventRequest;
  try {
    body = await request.json() as NotificationEventRequest;
  } catch {
    return NextResponse.json({ error: "The live notification request was invalid." }, { status: 400 });
  }
  if (body.event !== "stream_started" || typeof body.roomName !== "string" || !/^[a-z0-9][a-z0-9-]{5,79}$/i.test(body.roomName)) {
    return NextResponse.json({ error: "The live notification request was invalid." }, { status: 400 });
  }

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json({ error: "Live notifications are not configured yet." }, { status: 503 });
  }

  try {
    const { firestore } = getFirebaseAdmin();
    const programRef = firestore.collection("programs").doc("current");
    const program = await programRef.get();
    if (!program.exists || program.get("roomName") !== body.roomName) {
      return NextResponse.json({ error: "This service is no longer the current broadcast." }, { status: 409 });
    }

    const liveKit = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const [room] = await liveKit.listRooms([body.roomName]);
    if (!room) return NextResponse.json({ error: "The live room has not started yet." }, { status: 409 });
    const access = parsePublicStreamAccessPolicy(room.metadata);
    if (!access.allAccess || !access.individualAccess) {
      return NextResponse.json({ sent: 0, skipped: true, reason: "Individual access is off." });
    }

    const eventRef = firestore.collection("notificationEvents").doc(`live-${body.roomName}`);
    const claimed = await firestore.runTransaction(async (transaction) => {
      const previous = await transaction.get(eventRef);
      const status = previous.get("status");
      if (status === "sent") return false;
      if (status === "sending") {
        const updatedAt = previous.get("updatedAt");
        const updatedMs = updatedAt instanceof Date
          ? updatedAt.getTime()
          : updatedAt && typeof updatedAt === "object" && "toMillis" in updatedAt && typeof updatedAt.toMillis === "function"
            ? updatedAt.toMillis()
            : 0;
        if (Date.now() - updatedMs < 120_000) return false;
      }
      transaction.set(eventRef, { event: "stream_started", roomName: body.roomName, status: "sending", updatedAt: new Date() });
      return true;
    });
    if (!claimed) return NextResponse.json({ sent: 0, alreadySent: true });

    const title = typeof program.get("title") === "string" ? program.get("title") as string : "ZoneStream live service";
    const sent = await sendIndividualNotification({
      title: "ZoneStream is live",
      body: title,
      url: `/stream/watch/${body.roomName}?title=${encodeURIComponent(title)}`,
      kind: "live_started",
      tag: `live-${body.roomName}`,
    });
    await eventRef.update({ status: "sent", sentDeviceCount: sent, updatedAt: new Date() });
    return NextResponse.json({ sent });
  } catch {
    return NextResponse.json({ error: "We could not send the live notification." }, { status: 503 });
  }
}
