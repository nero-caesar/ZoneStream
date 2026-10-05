import { createHmac } from "node:crypto";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { getRequestAccount, isSameOriginRequest } from "../../../../lib/auth/server";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";

export const runtime = "nodejs";

function validRoomName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{5,79}$/i.test(value);
}

function inviteHash(token: string, secret: string): string {
  return createHmac("sha256", secret).update("zonestream-remote-presenter:").update(token).digest("hex");
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please open the presenter invite from ZoneStream." }, { status: 403 });
  const account = await getRequestAccount(request);
  if (!account) return NextResponse.json({ error: "Sign in to your ZoneStream account before joining as presenter." }, { status: 401 });
  if (account.profile.role === "zonal") return NextResponse.json({ error: "Studio accounts manage the service from the broadcast studio." }, { status: 403 });

  let body: { roomName?: unknown; inviteToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "This presenter invite is not valid." }, { status: 400 });
  }
  if (!validRoomName(body.roomName) || typeof body.inviteToken !== "string" || body.inviteToken.length < 32 || body.inviteToken.length > 128) {
    return NextResponse.json({ error: "This presenter invite is not valid." }, { status: 400 });
  }
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return NextResponse.json({ error: "Remote presenting is not ready right now." }, { status: 503 });

  try {
    const { firestore } = getFirebaseAdmin();
    const currentProgram = await firestore.collection("programs").doc("current").get();
    if (currentProgram.data()?.roomName !== body.roomName) return NextResponse.json({ error: "This live service has ended." }, { status: 404 });
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const [activeRoom] = await roomService.listRooms([body.roomName]);
    if (!activeRoom) return NextResponse.json({ error: "This live service has ended." }, { status: 404 });

    const matching = await firestore.collection("remotePresenterInvites")
      .where("tokenHash", "==", inviteHash(body.inviteToken, LIVEKIT_API_SECRET))
      .get();
    const inviteDoc = matching.docs.find((doc) => doc.data().roomName === body.roomName);
    if (!inviteDoc) return NextResponse.json({ error: "This presenter invite is invalid. Ask the studio for a new one." }, { status: 404 });

    let claimError = "";
    await firestore.runTransaction(async (transaction) => {
      const latest = await transaction.get(inviteDoc.ref);
      const invite = latest.data();
      if (!latest.exists || invite?.active !== true || invite.roomName !== body.roomName) {
        claimError = "This presenter invite has been turned off. Ask the studio for a new one.";
        return;
      }
      if (typeof invite.claimedByUid === "string" && invite.claimedByUid !== account.profile.uid) {
        claimError = "This presenter invite is already assigned to another account.";
        return;
      }
      transaction.update(inviteDoc.ref, {
        claimedByUid: account.profile.uid,
        presenterName: account.profile.displayName,
        claimedAt: typeof invite.claimedAt === "string" ? invite.claimedAt : new Date().toISOString(),
      });
    });
    if (claimError) return NextResponse.json({ error: claimError }, { status: 403 });

    const identity = `presenter-${inviteDoc.id}`;
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: account.profile.displayName,
      metadata: JSON.stringify({
        audienceType: "presenter",
        role: "remote-presenter",
        remotePresenterInviteId: inviteDoc.id,
        accountUid: account.profile.uid,
      }),
      ttl: "24h",
    });
    token.addGrant({
      roomJoin: true,
      room: body.roomName,
      canPublish: true,
      canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
      canSubscribe: false,
      canPublishData: false,
    });
    return NextResponse.json({ serverUrl: LIVEKIT_URL, participantToken: await token.toJwt(), presenterName: account.profile.displayName, inviteId: inviteDoc.id });
  } catch {
    return NextResponse.json({ error: "ZoneStream could not prepare the presenter connection." }, { status: 503 });
  }
}
