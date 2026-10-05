import { RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { verifyDeveloperRequest } from "../../../../lib/auth/developer-space";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";
import { disconnectRoomParticipants } from "../../../../lib/stream/disconnect-participants";
import { isPlatformViewerPaused } from "../../../../lib/stream/access-policy";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!await verifyDeveloperRequest(request)) return NextResponse.json({ error: "Sign in to Developer Space." }, { status: 401 });
  try {
    const { firestore } = getFirebaseAdmin();
    const [program, controls, audit, platformActivity] = await Promise.all([
      firestore.collection("programs").doc("current").get(),
      firestore.collection("platformControl").doc("access").get(),
      firestore.collection("developerAuditLog").orderBy("at", "desc").limit(40).get(),
      firestore.collection("platformActivity").orderBy("at", "desc").limit(80).get(),
    ]);
    const current = program.data();
    const activity = [
      ...platformActivity.docs.map((document) => ({ id: `platform-${document.id}`, action: String(document.get("action") ?? "platform_activity"), label: String(document.get("label") ?? "A platform activity was recorded"), at: String(document.get("at") ?? "") })),
      ...audit.docs.map((document) => ({ id: `owner-${document.id}`, action: String(document.get("action") ?? "owner_action"), label: "Developer Space activity", at: String(document.get("at") ?? "") })),
    ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 80);
    return NextResponse.json({
      program: current && typeof current.roomName === "string"
        ? { roomName: current.roomName, title: typeof current.title === "string" ? current.title : "Zonal Church Live Service", startedAt: String(current.startedAt ?? "") }
        : null,
      viewerPaused: controls.exists && controls.get("viewerPaused") === true,
      activity,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Developer Space could not load its owner dashboard." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please manage ZoneStream from Developer Space." }, { status: 403 });
  if (!await verifyDeveloperRequest(request)) return NextResponse.json({ error: "Sign in to Developer Space." }, { status: 401 });

  let body: { viewerPaused?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Choose whether viewer access should be paused." }, { status: 400 });
  }
  if (typeof body.viewerPaused !== "boolean") return NextResponse.json({ error: "Choose whether viewer access should be paused." }, { status: 400 });

  try {
    const { firestore } = getFirebaseAdmin();
    const now = new Date().toISOString();
    await firestore.collection("platformControl").doc("access").set({ viewerPaused: body.viewerPaused, updatedAt: now });
    let disconnectedCount = 0;
    let remainingCount = 0;
    let warning: string | undefined;
    let currentRoomName: string | undefined;
    const program = (await firestore.collection("programs").doc("current").get()).data();
    if (program && typeof program.roomName === "string") currentRoomName = program.roomName;

    if (currentRoomName) {
      const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
      if (LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
        try {
          const service = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
          const [activeRoom] = await service.listRooms([currentRoomName]);
          if (activeRoom) {
            if (isPlatformViewerPaused(activeRoom.metadata) !== body.viewerPaused) {
            let metadata: Record<string, unknown> = {};
            try {
              const parsed: unknown = JSON.parse(activeRoom.metadata || "{}");
              if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
            } catch {
              // Replace malformed room metadata with a clean access-policy envelope below.
            }
            await service.updateRoomMetadata(currentRoomName, JSON.stringify({ ...metadata, zoneStreamPlatformPaused: body.viewerPaused }));
            }
            if (body.viewerPaused) {
              const result = await disconnectRoomParticipants(service, currentRoomName, (participant) => participant.identity.startsWith("viewer-"));
              disconnectedCount = result.disconnectedCount;
              remainingCount = result.remainingCount;
              if (remainingCount > 0) warning = `${remainingCount} current viewer${remainingCount === 1 ? " remains" : "s remain"}. Viewer access is still paused; retry disconnecting.`;
            }
          }
        } catch {
          warning = body.viewerPaused
            ? "Viewer access is paused, but we could not confirm that current viewers were disconnected. Retry disconnecting."
            : "Viewer access resumed in the platform settings, but its live room could not be updated.";
        }
      } else {
        warning = body.viewerPaused
          ? "Viewer access is paused, but the live connection could not be reached to disconnect current viewers."
          : "Viewer access resumed in the platform settings, but its live room could not be updated.";
      }
    }

    await firestore.collection("developerAuditLog").add({
      action: body.viewerPaused ? "viewer_access_paused" : "viewer_access_resumed",
      at: now,
      disconnectedCount,
    }).catch(() => undefined);
    await recordPlatformActivity({
      action: body.viewerPaused ? "viewer_access_paused" : "viewer_access_resumed",
      label: body.viewerPaused ? `Developer Space paused viewer access and disconnected ${disconnectedCount} viewer${disconnectedCount === 1 ? "" : "s"}` : "Developer Space resumed viewer access",
      actorType: "developer",
      actorName: "ZoneStream Developer",
      roomName: currentRoomName,
    });
    return NextResponse.json({ viewerPaused: body.viewerPaused, disconnectedCount, remainingCount, ...(warning ? { warning } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "The platform access setting could not be saved. Please try again." }, { status: 503 });
  }
}
