import { timingSafeEqual } from "node:crypto";
import { RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function matchesSecret(input: string, expected: string): boolean {
  const inputBuffer = Buffer.from(input);
  const expectedBuffer = Buffer.from(expected);

  return inputBuffer.length === expectedBuffer.length && timingSafeEqual(inputBuffer, expectedBuffer);
}

export async function POST(request: NextRequest) {
  let body: { roomName?: unknown; hostPin?: unknown };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please send a valid end request." }, { status: 400 });
  }

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_DEMO_HOST_PIN } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_DEMO_HOST_PIN) {
    return NextResponse.json({ error: "The streaming service is not configured for the studio yet." }, { status: 503 });
  }

  if (typeof body.roomName !== "string" || !/^[a-z0-9][a-z0-9-]{5,79}$/i.test(body.roomName)) {
    return NextResponse.json({ error: "That stream link is not valid." }, { status: 400 });
  }

  const hostPin = typeof body.hostPin === "string" ? body.hostPin : "";
  if (!matchesSecret(hostPin, LIVEKIT_DEMO_HOST_PIN)) {
    return NextResponse.json({ error: "The studio access code is incorrect." }, { status: 401 });
  }

  try {
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await roomService.deleteRoom(body.roomName);
    return NextResponse.json({ ended: true });
  } catch {
    return NextResponse.json({ error: "We could not end the broadcast. Please try again." }, { status: 502 });
  }
}
