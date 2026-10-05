import { createHmac, randomUUID } from "node:crypto";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { getRequestAccount, isSameOriginRequest } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { getProgramMonitorRoomName } from "../../../../lib/stream/program-monitor";

export const runtime = "nodejs";

function validRoomName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{5,79}$/i.test(value);
}

function inviteHash(token: string, secret: string): string {
  return createHmac("sha256", secret).update("zonestream-remote-presenter:").update(token).digest("hex");
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Open the program monitor from ZoneStream." }, { status: 403 });

  let body: { roomName?: unknown; role?: unknown; inviteToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "This program-monitor request is not valid." }, { status: 400 });
  }
  if (!validRoomName(body.roomName) || (body.role !== "studio" && body.role !== "presenter")) {
    return NextResponse.json({ error: "This program-monitor request is not valid." }, { status: 400 });
  }

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json({ error: "The program monitor is not available right now." }, { status: 503 });
  }

  try {
    const { firestore } = getFirebaseAdmin();
    const program = await firestore.collection("programs").doc("current").get();
    if (program.data()?.roomName !== body.roomName) return NextResponse.json({ error: "This live service has ended." }, { status: 404 });

    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const [liveRoom] = await roomService.listRooms([body.roomName]);
    if (!liveRoom) return NextResponse.json({ error: "This live service has ended." }, { status: 404 });

    const monitorRoomName = getProgramMonitorRoomName(body.roomName, LIVEKIT_API_SECRET);
    if (body.role === "studio") {
      const operator = await getStudioOperator(request);
      if (!operator) return NextResponse.json({ error: "Sign in to the Studio to publish the program monitor feed." }, { status: 403 });

      const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: `monitor-studio-${operator.uid}-${randomUUID()}`,
        name: "ZoneStream Program Feed",
        metadata: JSON.stringify({ role: "monitor-publisher", audienceType: "program-monitor" }),
        ttl: "60s",
      });
      token.addGrant({
        roomJoin: true,
        room: monitorRoomName,
        canPublish: true,
        canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
        canSubscribe: false,
        canPublishData: false,
      });
      return NextResponse.json({ serverUrl: LIVEKIT_URL, participantToken: await token.toJwt() }, { headers: { "Cache-Control": "no-store" } });
    }

    const account = await getRequestAccount(request);
    if (!account || account.profile.role === "zonal") {
      return NextResponse.json({ error: "Sign in with the account assigned to this presenter invite." }, { status: 403 });
    }
    if (typeof body.inviteToken !== "string" || body.inviteToken.length < 32 || body.inviteToken.length > 128) {
      return NextResponse.json({ error: "This presenter invite is not valid." }, { status: 400 });
    }

    const inviteMatches = await firestore.collection("remotePresenterInvites")
      .where("tokenHash", "==", inviteHash(body.inviteToken, LIVEKIT_API_SECRET))
      .limit(1)
      .get();
    const inviteDoc = inviteMatches.docs.find((document) => document.data().roomName === body.roomName);
    const invite = inviteDoc?.data();
    if (!inviteDoc || invite?.active !== true || invite.claimedByUid !== account.profile.uid) {
      return NextResponse.json({ error: "This presenter invite is no longer assigned to this account." }, { status: 403 });
    }

    const presenters = await roomService.listParticipants(body.roomName);
    const presenterConnected = presenters.some((participant) => participant.identity === `presenter-${inviteDoc.id}`);
    if (!presenterConnected) return NextResponse.json({ error: "Reconnect your presenter camera before opening the program monitor." }, { status: 409 });

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: `program-monitor-${inviteDoc.id}`,
      name: account.profile.displayName,
      metadata: JSON.stringify({ role: "monitor-viewer", audienceType: "presenter-monitor", presenterInviteId: inviteDoc.id }),
      ttl: "60s",
    });
    token.addGrant({
      roomJoin: true,
      room: monitorRoomName,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
    });
    return NextResponse.json({ serverUrl: LIVEKIT_URL, participantToken: await token.toJwt() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "ZoneStream could not prepare the program monitor." }, { status: 503 });
  }
}
