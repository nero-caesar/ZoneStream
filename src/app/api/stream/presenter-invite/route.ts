import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";
import { getProgramMonitorRoomName } from "../../../../lib/stream/program-monitor";

export const runtime = "nodejs";

function validRoomName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{5,79}$/i.test(value);
}

function inviteHash(token: string, secret: string): string {
  return createHmac("sha256", secret).update("zonestream-remote-presenter:").update(token).digest("hex");
}

function publicInvite(id: string, data: Record<string, unknown>, connected: boolean) {
  return {
    id,
    active: data.active === true,
    claimed: typeof data.claimedByUid === "string",
    presenterName: typeof data.presenterName === "string" ? data.presenterName : "",
    connected,
    connectedAt: typeof data.connectedAt === "string" ? data.connectedAt : "",
    disconnectedAt: typeof data.disconnectedAt === "string" ? data.disconnectedAt : "",
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
  };
}

async function requireRoom(request: NextRequest, roomName: unknown) {
  if (!validRoomName(roomName)) return { error: NextResponse.json({ error: "That live service link is not valid." }, { status: 400 }) };
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return { error: NextResponse.json({ error: "The live service is not ready for remote presenters." }, { status: 503 }) };
  }
  const { firestore } = getFirebaseAdmin();
  const program = await firestore.collection("programs").doc("current").get();
  if (program.data()?.roomName !== roomName) {
    return { error: NextResponse.json({ error: "This live service is no longer active." }, { status: 404 }) };
  }
  const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  const [room] = await roomService.listRooms([roomName]);
  if (!room) return { error: NextResponse.json({ error: "This live service is no longer active." }, { status: 404 }) };
  return { roomName, roomService, room, firestore, livekitSecret: LIVEKIT_API_SECRET };
}

export async function GET(request: NextRequest) {
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the studio to manage presenter access." }, { status: 403 });
  const context = await requireRoom(request, request.nextUrl.searchParams.get("roomName"));
  if ("error" in context) return context.error;

  try {
    const snapshot = await context.firestore.collection("remotePresenterInvites")
      .where("roomName", "==", context.roomName)
      .get();
    const participants = await context.roomService.listParticipants(context.roomName);
    const connectedInviteIds = new Set(participants.flatMap((participant) => {
      try {
        const metadata = JSON.parse(participant.metadata ?? "{}") as { remotePresenterInviteId?: unknown };
        return typeof metadata.remotePresenterInviteId === "string" ? [metadata.remotePresenterInviteId] : [];
      } catch {
        return [];
      }
    }));
    const invites = snapshot.docs
      .filter((doc) => doc.data().active === true)
      .map((doc) => publicInvite(doc.id, doc.data(), connectedInviteIds.has(doc.id)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return NextResponse.json({ invites });
  } catch {
    return NextResponse.json({ error: "Presenter status could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please manage presenter access from ZoneStream." }, { status: 403 });
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the studio to manage presenter access." }, { status: 403 });

  let body: { action?: unknown; roomName?: unknown; inviteId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please send a valid presenter-access request." }, { status: 400 });
  }
  if (body.action !== "create" && body.action !== "revoke") return NextResponse.json({ error: "Choose whether to create or revoke the invite." }, { status: 400 });
  const context = await requireRoom(request, body.roomName);
  if ("error" in context) return context.error;

  try {
    const invites = context.firestore.collection("remotePresenterInvites");
    const roomInvites = await invites.where("roomName", "==", context.roomName).get();
    const activeSnapshot = roomInvites.docs.filter((doc) => doc.data().active === true);
    if (body.action === "revoke") {
      if (typeof body.inviteId !== "string") return NextResponse.json({ error: "Select a presenter invite to revoke." }, { status: 400 });
      const selected = activeSnapshot.find((doc) => doc.id === body.inviteId);
      if (!selected) return NextResponse.json({ error: "That presenter invite is no longer active." }, { status: 404 });
      const participants = await context.roomService.listParticipants(context.roomName);
      const presenter = participants.find((participant) => {
        try {
          return (JSON.parse(participant.metadata ?? "{}") as { remotePresenterInviteId?: unknown }).remotePresenterInviteId === selected.id;
        } catch {
          return false;
        }
      });
      if (presenter) await context.roomService.removeParticipant(context.roomName, presenter.identity);
      const monitorRoomName = getProgramMonitorRoomName(context.roomName, context.livekitSecret);
      await context.roomService.removeParticipant(monitorRoomName, `program-monitor-${selected.id}`).catch(() => undefined);
      await selected.ref.update({ active: false, revokedAt: new Date().toISOString(), revokedBy: operator.uid });
      await recordPlatformActivity({ action: "remote_presenter_invite_revoked", label: `${operator.displayName} revoked remote presenter access`, actorType: operator.kind, actorName: operator.displayName, roomName: context.roomName });
      return NextResponse.json({ revoked: true });
    }

    const token = randomBytes(32).toString("base64url");
    const inviteId = randomUUID();
    const createdAt = new Date().toISOString();
    await invites.doc(inviteId).create({
      roomName: context.roomName,
      tokenHash: inviteHash(token, context.livekitSecret),
      active: true,
      createdAt,
      createdBy: operator.uid,
      claimedByUid: null,
      presenterName: null,
      connectedAt: null,
      disconnectedAt: null,
    });
    await recordPlatformActivity({ action: "remote_presenter_invite_created", label: `${operator.displayName} created remote presenter access`, actorType: operator.kind, actorName: operator.displayName, roomName: context.roomName });
    return NextResponse.json({
      invite: { id: inviteId, active: true, claimed: false, presenterName: "", connected: false, connectedAt: "", disconnectedAt: "", createdAt },
      inviteUrl: `${request.nextUrl.origin}/stream/presenter/${encodeURIComponent(context.roomName)}?invite=${encodeURIComponent(token)}`,
    });
  } catch {
    return NextResponse.json({ error: "Presenter access could not be updated. Please try again." }, { status: 503 });
  }
}
