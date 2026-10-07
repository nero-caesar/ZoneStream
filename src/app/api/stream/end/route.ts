import { RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";
import { isPlatformViewerPaused, parseStreamAccessPolicy, serializeStreamAccessPolicy } from "../../../../lib/stream/access-policy";
import { decryptPrivateSpecialAccessState, encryptPrivateSpecialAccessState } from "../../../../lib/stream/special-access-crypto";
import { recordDeveloperSpecialAccessConnection } from "../../../../lib/stream/developer-special-access";
import { getProgramMonitorRoomName } from "../../../../lib/stream/program-monitor";
import { finishAttendance, reconcileAttendance } from "../../../../lib/stream/attendance";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please end the broadcast from ZoneStream." }, { status: 403 });
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to end the broadcast." }, { status: 403 });

  let body: { roomName?: unknown };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please send a valid end request." }, { status: 400 });
  }

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json({ error: "The streaming service is not configured for the studio yet." }, { status: 503 });
  }

  if (typeof body.roomName !== "string" || !/^[a-z0-9][a-z0-9-]{5,79}$/i.test(body.roomName)) {
    return NextResponse.json({ error: "That stream link is not valid." }, { status: 400 });
  }

  try {
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const [activeRoom] = await roomService.listRooms([body.roomName]);
    const finalParticipants = activeRoom ? await roomService.listParticipants(body.roomName) : [];
    const attendanceEndedAt = new Date().toISOString();
    await reconcileAttendance(body.roomName, finalParticipants, activeRoom?.metadata || "");
    if (activeRoom) {
      const participants = await roomService.listParticipants(body.roomName).catch(() => []);
      const identities = new Set(participants.map((participant) => participant.identity));
      const decryptCodes = (encrypted: string) => decryptPrivateSpecialAccessState(encrypted, LIVEKIT_API_SECRET);
      const policy = parseStreamAccessPolicy(activeRoom.metadata, decryptCodes);
      let changedPolicy = false;
      const disconnectedAt = new Date().toISOString();
      for (const code of policy.specialAccessCodes) {
        if (code.redeemedBy && identities.has(code.redeemedBy.identity)) {
          code.redeemedBy.disconnectedAt = disconnectedAt;
          changedPolicy = true;
        }
      }
      if (changedPolicy) {
        await roomService.updateRoomMetadata(
          body.roomName,
          serializeStreamAccessPolicy(policy, encryptPrivateSpecialAccessState(policy.specialAccessCodes, LIVEKIT_API_SECRET), isPlatformViewerPaused(activeRoom.metadata)),
        ).catch(() => undefined);
      }
      await Promise.allSettled(participants.flatMap((participant) => {
        try {
          const metadata = JSON.parse(participant.metadata ?? "{}") as { developerSpecialAccessCodeId?: unknown };
          return typeof metadata.developerSpecialAccessCodeId === "string"
            ? [recordDeveloperSpecialAccessConnection({ codeId: metadata.developerSpecialAccessCodeId, identity: participant.identity, roomName: body.roomName as string, event: "disconnected" })]
            : [];
        } catch {
          return [];
        }
      }));
    }
    const { firestore } = getFirebaseAdmin();
    const activePresenterInvites = await firestore.collection("remotePresenterInvites")
      .where("roomName", "==", body.roomName)
      .get();
    const endTime = new Date().toISOString();
    const inviteBatch = firestore.batch();
    activePresenterInvites.docs.filter((invite) => invite.data().active === true).forEach((invite) => inviteBatch.update(invite.ref, {
      active: false,
      endedAt: endTime,
      disconnectedAt: invite.data().claimedByUid ? endTime : null,
      endedBy: operator.uid,
    }));
    if (activePresenterInvites.docs.some((invite) => invite.data().active === true)) await inviteBatch.commit().catch(() => undefined);
    await roomService.deleteRoom(getProgramMonitorRoomName(body.roomName, LIVEKIT_API_SECRET)).catch(() => undefined);
    if (activeRoom) await roomService.deleteRoom(body.roomName);
    await finishAttendance(body.roomName, finalParticipants, attendanceEndedAt);
    await recordPlatformActivity({ action: "service_ended", label: `${operator.displayName} ended the live service`, actorType: operator.kind, actorName: operator.displayName, roomName: body.roomName });
    try {
      const { firestore } = getFirebaseAdmin();
      const programRef = firestore.collection("programs").doc("current");
      const program = await programRef.get();
      if (program.data()?.roomName === body.roomName) await programRef.delete();
    } catch {
      // The room is already ended; a stale dashboard listing is ignored once LiveKit confirms it is gone.
    }
    return NextResponse.json({ ended: true });
  } catch {
    return NextResponse.json({ error: "We could not end the broadcast. Please try again." }, { status: 502 });
  }
}
