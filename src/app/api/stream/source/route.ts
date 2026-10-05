import { RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { getRequestAccount, isSameOriginRequest } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { verifyDeveloperRequest } from "../../../../lib/auth/developer-space";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";

export const runtime = "nodejs";

type SourceMode = "auto" | "studio" | "presenter" | "flier" | "flier-audio";

function validRoomName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{5,79}$/i.test(value);
}

function sourceForProgram(program: Record<string, unknown> | undefined) {
  const mode = program?.activeSourceMode;
  const serviceFlier = program?.serviceFlier as { objectKey?: unknown; fileName?: unknown } | null | undefined;
  return {
    mode: mode === "studio" || mode === "presenter" || mode === "flier" || mode === "flier-audio" ? mode : "auto",
    inviteId: typeof program?.activeSourceInviteId === "string" ? program.activeSourceInviteId : "",
    flierKey: typeof serviceFlier?.objectKey === "string" ? serviceFlier.objectKey : "",
    flierFileName: typeof serviceFlier?.fileName === "string" ? serviceFlier.fileName : "",
    updatedAt: typeof program?.activeSourceUpdatedAt === "string" ? program.activeSourceUpdatedAt : "",
  } as const;
}

export async function GET(request: NextRequest) {
  const account = await getRequestAccount(request);
  const developer = await verifyDeveloperRequest(request);
  if (!account && !developer) return NextResponse.json({ error: "Sign in to view the broadcast source." }, { status: 401 });
  if (account?.profile.role === "zonal" && !developer && !(await getStudioOperator(request))) {
    return NextResponse.json({ error: "Sign in to view the broadcast source." }, { status: 403 });
  }
  const roomName = request.nextUrl.searchParams.get("roomName");
  if (!validRoomName(roomName)) return NextResponse.json({ error: "That live service link is not valid." }, { status: 400 });
  try {
    const { firestore } = getFirebaseAdmin();
    const program = await firestore.collection("programs").doc("current").get();
    if (program.data()?.roomName !== roomName) return NextResponse.json({ error: "This live service has ended." }, { status: 404 });
    return NextResponse.json({ source: sourceForProgram(program.data()) });
  } catch {
    return NextResponse.json({ error: "The broadcast source could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Choose the live feed from ZoneStream Studio." }, { status: 403 });
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the Studio to change the broadcast feed." }, { status: 403 });
  let body: { roomName?: unknown; mode?: unknown; inviteId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "This feed selection is not valid." }, { status: 400 });
  }
  const roomName = body.roomName;
  const mode = body.mode;
  const inviteId = typeof body.inviteId === "string" ? body.inviteId : "";
  if (!validRoomName(roomName) || (mode !== "auto" && mode !== "studio" && mode !== "presenter" && mode !== "flier" && mode !== "flier-audio") || (mode === "presenter" && !inviteId)) {
    return NextResponse.json({ error: "Choose Studio, a connected presenter, or the service flier." }, { status: 400 });
  }
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return NextResponse.json({ error: "The live service is not ready for feed switching." }, { status: 503 });

  try {
    const { firestore } = getFirebaseAdmin();
    const programRef = firestore.collection("programs").doc("current");
    const program = await programRef.get();
    if (program.data()?.roomName !== roomName) return NextResponse.json({ error: "This live service has ended." }, { status: 404 });
    const serviceFlier = program.data()?.serviceFlier as { objectKey?: unknown; fileName?: unknown } | null | undefined;
    if ((mode === "flier" || mode === "flier-audio") && typeof serviceFlier?.objectKey !== "string") {
      return NextResponse.json({ error: "Upload a service flier before putting it on air." }, { status: 409 });
    }
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const [activeRoom] = await roomService.listRooms([roomName]);
    if (!activeRoom) return NextResponse.json({ error: "This live service has ended." }, { status: 404 });

    if (mode === "presenter" || ((mode === "auto" || mode === "flier-audio") && inviteId)) {
      const invite = await firestore.collection("remotePresenterInvites").doc(inviteId).get();
      if (!invite.exists || invite.data()?.active !== true || invite.data()?.roomName !== roomName) {
        return NextResponse.json({ error: "That presenter invite is no longer active." }, { status: 404 });
      }
      const participants = await roomService.listParticipants(roomName);
      const presenterConnected = participants.some((participant) => {
        try {
          const metadata = JSON.parse(participant.metadata ?? "{}") as { role?: unknown; remotePresenterInviteId?: unknown };
          return metadata.role === "remote-presenter" && metadata.remotePresenterInviteId === inviteId;
        } catch {
          return false;
        }
      });
      if (!presenterConnected) return NextResponse.json({ error: "That presenter is not connected right now." }, { status: 409 });
    }

    const updatedAt = new Date().toISOString();
    const nextSource = { mode: mode as SourceMode, inviteId: mode === "presenter" || mode === "auto" || mode === "flier-audio" ? inviteId : "", updatedAt };
    await programRef.update({
      activeSourceMode: nextSource.mode,
      activeSourceInviteId: nextSource.inviteId || null,
      activeSourceUpdatedAt: updatedAt,
    });
    return NextResponse.json({ source: { ...nextSource, flierKey: typeof serviceFlier?.objectKey === "string" ? serviceFlier.objectKey : "", flierFileName: typeof serviceFlier?.fileName === "string" ? serviceFlier.fileName : "" } });
  } catch {
    return NextResponse.json({ error: "ZoneStream could not change the broadcast feed." }, { status: 503 });
  }
}
