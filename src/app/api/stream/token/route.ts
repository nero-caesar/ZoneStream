import { randomUUID, timingSafeEqual } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type JoinRequest = {
  roomName?: unknown;
  participantName?: unknown;
  role?: unknown;
  hostPin?: unknown;
};

function isValidRoomName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{5,79}$/i.test(value);
}

function matchesSecret(input: string, expected: string): boolean {
  const inputBuffer = Buffer.from(input);
  const expectedBuffer = Buffer.from(expected);

  return inputBuffer.length === expectedBuffer.length && timingSafeEqual(inputBuffer, expectedBuffer);
}

export async function POST(request: NextRequest) {
  let body: JoinRequest;

  try {
    body = (await request.json()) as JoinRequest;
  } catch {
    return NextResponse.json({ error: "Please send a valid join request." }, { status: 400 });
  }

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_DEMO_HOST_PIN } = process.env;

  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json(
      { error: "Live streaming is not connected yet. Add the LiveKit values to .env.local and restart the app." },
      { status: 503 },
    );
  }

  if (!isValidRoomName(body.roomName)) {
    return NextResponse.json({ error: "That stream link is not valid." }, { status: 400 });
  }

  const role = body.role === "host" ? "host" : body.role === "viewer" ? "viewer" : null;
  if (!role) {
    return NextResponse.json({ error: "Choose whether you are hosting or watching." }, { status: 400 });
  }

  const participantName = typeof body.participantName === "string" ? body.participantName.trim() : "";
  if (!participantName || participantName.length > 60) {
    return NextResponse.json({ error: "Enter a name between 1 and 60 characters." }, { status: 400 });
  }

  if (role === "host") {
    if (!LIVEKIT_DEMO_HOST_PIN) {
      return NextResponse.json(
        { error: "Set LIVEKIT_DEMO_HOST_PIN in .env.local before starting a broadcast." },
        { status: 503 },
      );
    }

    const hostPin = typeof body.hostPin === "string" ? body.hostPin : "";
    if (!matchesSecret(hostPin, LIVEKIT_DEMO_HOST_PIN)) {
      return NextResponse.json({ error: "The studio access code is incorrect." }, { status: 401 });
    }
  }

  const accessToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: `${role}-${randomUUID()}`,
    name: participantName,
    ttl: "24h",
  });

  accessToken.addGrant({
    roomJoin: true,
    room: body.roomName,
    canPublish: role === "host",
    canSubscribe: true,
    canPublishData: role === "host",
  });

  return NextResponse.json({
    serverUrl: LIVEKIT_URL,
    participantToken: await accessToken.toJwt(),
  });
}
