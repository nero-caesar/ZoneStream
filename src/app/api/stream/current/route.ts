import { RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { getRequestAccount } from "../../../../lib/auth/server";
import { verifyDeveloperRequest } from "../../../../lib/auth/developer-space";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { getDeveloperSpecialAccessGrant } from "../../../../lib/stream/developer-special-access";
import { parsePublicStreamAccessPolicy } from "../../../../lib/stream/access-policy";
import { hashChurchAccessKey } from "../../../../lib/stream/special-access-crypto";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const account = await getRequestAccount(request);
  const developerPreview = await verifyDeveloperRequest(request);
  if ((!account && !developerPreview) || (account?.profile.role === "zonal" && !developerPreview)) return NextResponse.json({ error: "Sign in to view live services." }, { status: 401 });

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return NextResponse.json({ program: null });

  try {
    const { firestore } = getFirebaseAdmin();
    const snapshot = await firestore.collection("programs").doc("current").get();
    if (!snapshot.exists) return NextResponse.json({ program: null });
    const current = snapshot.data();
    if (!current || typeof current.roomName !== "string") return NextResponse.json({ program: null });
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const [room] = await roomService.listRooms([current.roomName]);
    if (!room) return NextResponse.json({ program: null });
    const access = parsePublicStreamAccessPolicy(room.metadata);
    const controls = await firestore.collection("platformControl").doc("access").get();
    const viewerPaused = controls.exists && controls.get("viewerPaused") === true;
    const developerGrant = account ? await getDeveloperSpecialAccessGrant(account.profile.uid, current.roomName) : null;
    const churchKey = account?.profile.role === "church" ? hashChurchAccessKey(account.profile.uid, LIVEKIT_API_SECRET) : "";
    const accountAccessOpen = access.allAccess && (account?.profile.role === "church"
      ? access.churchAccess && !access.blockedChurchAccessKeys.includes(churchKey)
      : access.individualAccess);
    const developerSpecialAccess = !viewerPaused && Boolean(developerGrant);
    const regularAccessOpen = developerPreview || (!viewerPaused && accountAccessOpen);
    const audienceOpen = developerPreview || (!viewerPaused && Boolean(developerGrant || accountAccessOpen));

    return NextResponse.json({
      program: {
        roomName: current.roomName,
        title: typeof current.title === "string" ? current.title : "Zonal Church Live Service",
        activeSource: {
          mode: current.activeSourceMode === "studio" || current.activeSourceMode === "presenter" || current.activeSourceMode === "flier" || current.activeSourceMode === "flier-audio" ? current.activeSourceMode : "auto",
          inviteId: typeof current.activeSourceInviteId === "string" ? current.activeSourceInviteId : "",
        },
        shareUrl: typeof current.shareUrl === "string" ? current.shareUrl : "",
        startedAt: typeof current.startedAt === "string" ? current.startedAt : "",
        audienceOpen,
        regularAccessOpen,
        developerSpecialAccess,
        viewerPaused,
        developerPreview,
        specialAccess: access.specialAccess,
        specialCodeAvailable: access.specialAccessCodeStates.some((code) => code.enabled),
      },
    });
  } catch {
    return NextResponse.json({ error: "We could not load the live service right now." }, { status: 503 });
  }
}
