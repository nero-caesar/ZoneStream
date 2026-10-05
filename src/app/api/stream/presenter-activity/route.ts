import { NextRequest, NextResponse } from "next/server";
import { getRequestAccount, isSameOriginRequest } from "../../../../lib/auth/server";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";

export const runtime = "nodejs";

function validRoomName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{5,79}$/i.test(value);
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please report presenter status from ZoneStream." }, { status: 403 });
  const account = await getRequestAccount(request);
  if (!account || account.profile.role === "zonal") return NextResponse.json({ error: "Sign in with the account assigned to this presenter invite." }, { status: 403 });

  let body: { roomName?: unknown; inviteId?: unknown; event?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "This presenter status update is not valid." }, { status: 400 });
  }
  if (!validRoomName(body.roomName) || typeof body.inviteId !== "string" || (body.event !== "connected" && body.event !== "disconnected")) {
    return NextResponse.json({ error: "This presenter status update is not valid." }, { status: 400 });
  }

  try {
    const { firestore } = getFirebaseAdmin();
    const inviteRef = firestore.collection("remotePresenterInvites").doc(body.inviteId);
    const invite = await inviteRef.get();
    const data = invite.data();
    if (!invite.exists || data?.active !== true || data.roomName !== body.roomName || data.claimedByUid !== account.profile.uid) {
      return NextResponse.json({ error: "This presenter invite is no longer active." }, { status: 403 });
    }
    const now = new Date().toISOString();
    await inviteRef.update(body.event === "connected"
      ? { connectedAt: now, disconnectedAt: null, presenterName: account.profile.displayName }
      : { disconnectedAt: now });
    return NextResponse.json({ updated: true });
  } catch {
    return NextResponse.json({ error: "Presenter status could not be saved." }, { status: 503 });
  }
}
