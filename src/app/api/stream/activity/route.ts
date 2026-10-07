import { RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { isPlatformViewerPaused, parseStreamAccessPolicy, serializeStreamAccessPolicy } from "../../../../lib/stream/access-policy";
import { decryptPrivateSpecialAccessState, encryptPrivateSpecialAccessState } from "../../../../lib/stream/special-access-crypto";
import { recordDeveloperSpecialAccessConnection } from "../../../../lib/stream/developer-special-access";
import { recordAttendance } from "../../../../lib/stream/attendance";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Use the ZoneStream studio to record live activity." }, { status: 403 });
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the studio first." }, { status: 401 });

  let body: {
    roomName?: unknown;
    event?: unknown;
    audienceType?: unknown;
    participantName?: unknown;
    participantIdentity?: unknown;
    participantSid?: unknown;
    participantMetadata?: unknown;
    specialAccessCodeId?: unknown;
    developerSpecialAccessCodeId?: unknown;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "The live activity was invalid." }, { status: 400 });
  }
  if (
    typeof body.roomName !== "string" || !/^[a-z0-9][a-z0-9-]{5,79}$/i.test(body.roomName) ||
    (body.event !== "connected" && body.event !== "disconnected") ||
    (body.audienceType !== "church" && body.audienceType !== "individual" && body.audienceType !== "presenter")
  ) return NextResponse.json({ error: "The live activity was invalid." }, { status: 400 });

  const participantName = typeof body.participantName === "string" ? body.participantName.trim().slice(0, 120) : "A viewer";
  const participantIdentity = typeof body.participantIdentity === "string" ? body.participantIdentity : "";
  const specialAccessCodeId = typeof body.specialAccessCodeId === "string" ? body.specialAccessCodeId : "";
  const developerSpecialAccessCodeId = typeof body.developerSpecialAccessCodeId === "string" ? body.developerSpecialAccessCodeId : "";
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  try {
    const { firestore } = getFirebaseAdmin();
    const program = await firestore.collection("programs").doc("current").get();
    if (!program.exists || program.get("roomName") !== body.roomName) return NextResponse.json({ recorded: false }, { status: 409 });
    if (typeof body.participantSid === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(body.participantSid) && typeof body.participantMetadata === "string") {
      let roomMetadata = "";
      if (LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
        const [room] = await new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).listRooms([body.roomName]);
        roomMetadata = room?.metadata || "";
      }
      await recordAttendance(body.roomName, { sid: body.participantSid, identity: participantIdentity, name: participantName, metadata: body.participantMetadata }, body.event, undefined, roomMetadata);
    }

    if (developerSpecialAccessCodeId) {
      if (participantIdentity && LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
        await recordDeveloperSpecialAccessConnection({ codeId: developerSpecialAccessCodeId, identity: participantIdentity, roomName: body.roomName, event: body.event });
      }
      return NextResponse.json({ recorded: true, privateDeveloperAccess: true });
    }

    if (participantIdentity && specialAccessCodeId && LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
      const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
      const [activeRoom] = await roomService.listRooms([body.roomName]);
      if (activeRoom) {
        const decryptCodes = (encrypted: string) => decryptPrivateSpecialAccessState(encrypted, LIVEKIT_API_SECRET);
        const policy = parseStreamAccessPolicy(activeRoom.metadata, decryptCodes);
        const code = policy.specialAccessCodes.find((entry) => entry.id === specialAccessCodeId);
        if (code?.redeemedBy?.identity === participantIdentity) {
          const now = new Date().toISOString();
          if (body.event === "connected") {
            code.redeemedBy.connectedAt = now;
            delete code.redeemedBy.disconnectedAt;
          } else {
            code.redeemedBy.disconnectedAt = now;
          }
          await roomService.updateRoomMetadata(
            body.roomName,
            serializeStreamAccessPolicy(policy, encryptPrivateSpecialAccessState(policy.specialAccessCodes, LIVEKIT_API_SECRET), isPlatformViewerPaused(activeRoom.metadata)),
          );
        }
      }
    }
  } catch {
    return NextResponse.json({ error: "The live activity could not be checked." }, { status: 503 });
  }

  const audience = body.audienceType === "church" ? "church" : "individual viewer";
  await recordPlatformActivity({
    action: `${body.audienceType}_${body.event}`,
    label: `${participantName} ${body.event === "connected" ? "connected to" : "disconnected from"} the live service`,
    actorType: body.audienceType === "presenter" ? "system" : body.audienceType,
    actorName: participantName,
    subjectName: audience,
    roomName: body.roomName,
  });
  return NextResponse.json({ recorded: true });
}
