import { NextRequest, NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { getRequestAccount, isSameOriginRequest } from "../../../../lib/auth/server";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { getServiceReport, reconcileAttendance, recordAttendance } from "../../../../lib/stream/attendance";

export const runtime = "nodejs";
const validRoom = (room: unknown): room is string => typeof room === "string" && /^[a-z0-9][a-z0-9-]{5,79}$/i.test(room);
function roomService() {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) throw new Error("Stream unavailable");
  return new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
}

export async function GET(request: NextRequest) {
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to Studio to view attendance." }, { status: 403 });
  const roomName = request.nextUrl.searchParams.get("roomName");
  if (!validRoom(roomName)) return NextResponse.json({ error: "Invalid service." }, { status: 400 });
  try {
    const service = await getFirebaseAdmin().firestore.collection("serviceReports").doc(roomName).get();
    if (!service.exists) return NextResponse.json({ error: "No attendance report is available for this service." }, { status: 404 });
    if (service.get("endedAt")) return NextResponse.json({ report: await getServiceReport(roomName, operator.kind === "developer") }, { headers: { "Cache-Control": "no-store" } });
    const client = roomService();
    const [room] = await client.listRooms([roomName]);
    const participants = room ? await client.listParticipants(roomName) : [];
    await reconcileAttendance(roomName, participants, room?.metadata || "");
    const attendees = participants.flatMap((participant) => {
      try {
        const metadata = JSON.parse(participant.metadata || "{}");
        if (metadata.developerPreview || typeof metadata.developerSpecialAccessCodeId === "string" || (metadata.audienceType !== "individual" && metadata.audienceType !== "church")) return [];
        return [{ identity: participant.identity, name: participant.name, audienceType: metadata.audienceType, accountUid: metadata.accountUid }];
      } catch { return []; }
    });
    return NextResponse.json({ attendees }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Attendance could not be refreshed. Please retry." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Use ZoneStream to record attendance." }, { status: 403 });
  const account = await getRequestAccount(request);
  if (!account) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  try {
    const body = await request.json();
    if (!validRoom(body.roomName) || typeof body.sid !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.sid) || !["connected", "disconnected"].includes(body.event)) return NextResponse.json({ error: "Invalid attendance update." }, { status: 400 });
    if (body.event === "connected") {
      const client = roomService();
      const [room] = await client.listRooms([body.roomName]);
      const participants = room ? await client.listParticipants(body.roomName) : [];
      const participant = participants.find((entry) => entry.sid === body.sid && JSON.parse(entry.metadata || "{}").accountUid === account.profile.uid);
      if (!participant) return NextResponse.json({ recorded: false }, { status: 409 });
      await recordAttendance(body.roomName, participant, "connected", undefined, room?.metadata || "");
    } else {
      const ref = getFirebaseAdmin().firestore.collection("serviceReports").doc(body.roomName).collection("sessions").doc(body.sid);
      const session = await ref.get();
      if (session.get("accountUid") !== account.profile.uid) return NextResponse.json({ error: "Invalid attendance session." }, { status: 403 });
      await recordAttendance(body.roomName, { sid: body.sid, identity: session.get("identity"), metadata: JSON.stringify({ audienceType: session.get("audienceType"), accountUid: account.profile.uid }) }, "disconnected");
    }
    return NextResponse.json({ recorded: true });
  } catch { return NextResponse.json({ error: "Attendance could not be saved." }, { status: 503 }); }
}
