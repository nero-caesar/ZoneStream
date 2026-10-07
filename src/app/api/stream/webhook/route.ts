import { WebhookReceiver } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { recordAttendance } from "../../../../lib/stream/attendance";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return new NextResponse(null, { status: 503 });
  let event;
  try { event = await new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET).receive(await request.text(), request.headers.get("authorization") || ""); }
  catch { return new NextResponse(null, { status: 401 }); }
  try {
    if (event.room && event.participant && (event.event === "participant_joined" || event.event === "participant_left")) {
      await recordAttendance(event.room.name, event.participant, event.event === "participant_joined" ? "connected" : "disconnected", new Date(Number(event.createdAt) * 1000).toISOString(), event.room.metadata);
    }
    return NextResponse.json({ received: true });
  } catch { return new NextResponse(null, { status: 503 }); }
}
