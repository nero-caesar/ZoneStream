import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { getRequestAccount, isSameOriginRequest } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { verifyDeveloperRequest } from "../../../../lib/auth/developer-space";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";
import { AUTH_SPECIAL_SESSION_COOKIE } from "../../../../lib/auth/session";
import { isPlatformViewerPaused, parseStreamAccessPolicy, serializeStreamAccessPolicy } from "../../../../lib/stream/access-policy";
import {
  decryptPrivateSpecialAccessState,
  encryptPrivateSpecialAccessState,
  hashChurchAccessKey,
  matchesSpecialAccessCode,
} from "../../../../lib/stream/special-access-crypto";
import {
  claimDeveloperSpecialAccessCode,
  getDeveloperSpecialAccessGrant,
} from "../../../../lib/stream/developer-special-access";

export const runtime = "nodejs";

type JoinRequest = {
  roomName?: unknown;
  participantName?: unknown;
  role?: unknown;
  audienceType?: unknown;
  accessCode?: unknown;
  developerPreview?: unknown;
};

const claimQueues = new Map<string, Promise<void>>();
const invalidCodeAttempts = new Map<string, { count: number; resetsAt: number }>();
const INVALID_CODE_LIMIT = 8;
const INVALID_CODE_WINDOW_MS = 10 * 60 * 1000;

function isValidRoomName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{5,79}$/i.test(value);
}

function codeAttemptKey(request: NextRequest, roomName: string): string {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown-client";
  return createHash("sha256").update(`${roomName}:${address}`).digest("hex");
}

function checkCodeAttemptLimit(key: string): boolean {
  const now = Date.now();
  const current = invalidCodeAttempts.get(key);
  if (!current || current.resetsAt <= now) {
    invalidCodeAttempts.set(key, { count: 0, resetsAt: now + INVALID_CODE_WINDOW_MS });
    return true;
  }
  return current.count < INVALID_CODE_LIMIT;
}

function recordInvalidCodeAttempt(key: string): void {
  const current = invalidCodeAttempts.get(key);
  if (!current || current.resetsAt <= Date.now()) {
    invalidCodeAttempts.set(key, { count: 1, resetsAt: Date.now() + INVALID_CODE_WINDOW_MS });
    return;
  }
  current.count += 1;
}

function hashSessionToken(value: string, secret: string): string {
  return createHmac("sha256", secret).update("special-access-session:").update(value).digest("hex");
}

function matchesHash(inputHash: string, storedHash: string): boolean {
  const input = Buffer.from(inputHash, "hex");
  const stored = Buffer.from(storedHash, "hex");
  return input.length === stored.length && timingSafeEqual(input, stored);
}

async function withRoomClaimLock<T>(roomName: string, task: () => Promise<T>): Promise<T> {
  const previous = claimQueues.get(roomName) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  claimQueues.set(roomName, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (claimQueues.get(roomName) === current) claimQueues.delete(roomName);
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please connect from the ZoneStream website." }, { status: 403 });
  let body: JoinRequest;

  try {
    body = (await request.json()) as JoinRequest;
  } catch {
    return NextResponse.json({ error: "Please send a valid join request." }, { status: 400 });
  }

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json(
      { error: "Live streaming is not available right now. Please try again later." },
      { status: 503 },
    );
  }

  if (!isValidRoomName(body.roomName)) {
    return NextResponse.json({ error: "That stream link is not valid." }, { status: 400 });
  }
  const roomName = body.roomName;

  const role = body.role === "host" ? "host" : body.role === "viewer" ? "viewer" : null;
  if (!role) {
    return NextResponse.json({ error: "Choose whether you are hosting or watching." }, { status: 400 });
  }

  const account = await getRequestAccount(request);
  const developerPreview = role === "viewer" && body.developerPreview === true && await verifyDeveloperRequest(request);
  const studioOperator = role === "host" ? await getStudioOperator(request) : null;
  if (!account && !developerPreview && !studioOperator) return NextResponse.json({ error: "Sign in to ZoneStream before connecting." }, { status: 401 });
  if (role === "host" && !studioOperator) {
    return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to start a broadcast." }, { status: 403 });
  }
  if (role === "viewer" && account?.profile.role === "zonal" && !developerPreview) {
    return NextResponse.json({ error: "Use the broadcast studio to manage the live service." }, { status: 403 });
  }

  let participantName = developerPreview ? "ZoneStream Developer" : role === "host" ? studioOperator?.displayName ?? "ZoneStream Studio" : account?.profile.displayName ?? "Viewer";
  let audienceType: "host" | "individual" | "church" | "developer" = developerPreview ? "developer" : role === "host"
    ? "host"
    : account?.profile.role === "church" ? "church" : "individual";

  try {
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    let identity = role === "host" ? `host-${studioOperator!.uid}` : developerPreview ? `developer-preview-${randomUUID()}` : `viewer-${account!.profile.uid}`;
    let specialCodeId: string | undefined;
    let developerSpecialAccessCodeId: string | undefined;

    if (role === "viewer" && developerPreview) {
      const [activeRoom] = await roomService.listRooms([roomName]);
      if (!activeRoom) return NextResponse.json({ error: "This live service is no longer available." }, { status: 404 });
    } else if (role === "viewer") {
      const [activeRoom] = await roomService.listRooms([roomName]);
      if (!activeRoom) {
        return NextResponse.json({ error: "This live service is no longer available." }, { status: 404 });
      }

      const platformAccess = await getFirebaseAdmin().firestore.collection("platformControl").doc("access").get();
      if ((platformAccess.exists && platformAccess.get("viewerPaused") === true) || isPlatformViewerPaused(activeRoom.metadata)) {
        return NextResponse.json({ error: "The platform owner has paused viewer access. Please try again later." }, { status: 403 });
      }

      const decryptCodes = (encrypted: string) => decryptPrivateSpecialAccessState(encrypted, LIVEKIT_API_SECRET);
      const initialPolicy = parseStreamAccessPolicy(activeRoom.metadata, decryptCodes);
      const requestedCode = typeof body.accessCode === "string" ? body.accessCode.trim().toUpperCase() : "";
      const specialSessionId = request.cookies.get(AUTH_SPECIAL_SESSION_COOKIE)?.value;
      const specialSessionHash = specialSessionId
        ? hashSessionToken(`${account!.profile.uid}:${specialSessionId}`, LIVEKIT_API_SECRET)
        : "";
      const sessionCode = specialSessionHash
        ? initialPolicy.specialAccessCodes.find((entry) => entry.redeemedBy && matchesHash(specialSessionHash, entry.redeemedBy.sessionHash))
        : undefined;

      if (requestedCode) {
        const developerClaim = await claimDeveloperSpecialAccessCode({
          code: requestedCode,
          uid: account!.profile.uid,
          name: participantName,
          audienceType: audienceType as "individual" | "church",
          roomName,
          secret: LIVEKIT_API_SECRET,
        });
        if (developerClaim.status === "denied") {
          return NextResponse.json({ error: developerClaim.message }, { status: 403 });
        }
        if (developerClaim.status === "granted") {
          participantName = developerClaim.record.redeemedBy?.name ?? participantName;
          audienceType = developerClaim.record.redeemedBy?.audienceType ?? audienceType;
          identity = developerClaim.identity;
          developerSpecialAccessCodeId = developerClaim.record.id;
        }
      } else {
        const developerGrant = await getDeveloperSpecialAccessGrant(account!.profile.uid, roomName);
        if (developerGrant) {
          participantName = developerGrant.record.redeemedBy?.name ?? participantName;
          audienceType = developerGrant.record.redeemedBy?.audienceType ?? audienceType;
          identity = developerGrant.identity;
          developerSpecialAccessCodeId = developerGrant.record.id;
        }
      }

      if (requestedCode && !developerSpecialAccessCodeId) {
        if (!specialSessionHash) {
          return NextResponse.json({ error: "Your sign-in session could not be verified. Sign out and back in, then try again." }, { status: 401 });
        }
        const attemptKey = codeAttemptKey(request, body.roomName);
        if (!checkCodeAttemptLimit(attemptKey)) {
          return NextResponse.json({ error: "Too many code attempts. Wait a few minutes before trying again." }, { status: 429 });
        }
        if (!/^[A-Z0-9]{6}$/.test(requestedCode)) {
          recordInvalidCodeAttempt(attemptKey);
          return NextResponse.json({ error: "Enter the six-character special-access code." }, { status: 400 });
        }

        const result = await withRoomClaimLock(body.roomName, async () => {
          const [freshRoom] = await roomService.listRooms([roomName]);
          if (!freshRoom) return { error: "This live service is no longer available." };
          const policy = parseStreamAccessPolicy(freshRoom.metadata, decryptCodes);
          const matchedCode = policy.specialAccessCodes.find((entry) => matchesSpecialAccessCode(requestedCode, entry.codeHash, LIVEKIT_API_SECRET));
          if (!matchedCode) {
            recordInvalidCodeAttempt(attemptKey);
            return { error: "That special-access code was not found. Check it and try again." };
          }
          invalidCodeAttempts.delete(attemptKey);
          if (!policy.specialAccess || !matchedCode.enabled) {
            return { error: "Special access for this code is currently off. Ask the Zonal Church to turn it on." };
          }

          if (matchedCode.redeemedBy) {
            if (!matchesHash(specialSessionHash, matchedCode.redeemedBy.sessionHash)) {
              return { error: "That code has already been used. Ask the Zonal Church for a new code." };
            }
            return {
              name: matchedCode.redeemedBy.name,
              audienceType: matchedCode.redeemedBy.audienceType,
              identity: matchedCode.redeemedBy.identity,
              codeId: matchedCode.id,
              policy,
            };
          }

          if (sessionCode) {
            return { error: "This signed-in session already has a special-access code for this service." };
          }

            const participantIdentity = `viewer-${account!.profile.uid}-${randomUUID().slice(0, 8)}`;
          matchedCode.redeemedBy = {
            name: participantName,
            audienceType: audienceType as "individual" | "church",
            identity: participantIdentity,
            sessionHash: specialSessionHash,
            usedAt: new Date().toISOString(),
          };
          await roomService.updateRoomMetadata(
            roomName,
            serializeStreamAccessPolicy(policy, encryptPrivateSpecialAccessState(policy.specialAccessCodes, LIVEKIT_API_SECRET), isPlatformViewerPaused(freshRoom.metadata)),
          );
          return {
            name: participantName,
            audienceType: audienceType as "individual" | "church",
            identity: participantIdentity,
            codeId: matchedCode.id,
            policy,
          };
        });

        if ("error" in result) return NextResponse.json({ error: result.error }, { status: 403 });
        participantName = result.name;
        audienceType = result.audienceType;
        identity = result.identity;
        specialCodeId = result.codeId;
      } else if (developerSpecialAccessCodeId) {
        // Developer grants are independent of the Zonal Studio attendance rules.
      } else if (sessionCode?.redeemedBy) {
        if (!initialPolicy.specialAccess || !sessionCode.enabled) {
          return NextResponse.json({ error: "Special access for this code is currently off. Ask the Zonal Church to turn it on." }, { status: 403 });
        }
        participantName = sessionCode.redeemedBy.name;
        audienceType = sessionCode.redeemedBy.audienceType;
        identity = sessionCode.redeemedBy.identity;
        specialCodeId = sessionCode.id;
      } else {
        if (!initialPolicy.allAccess) {
          return NextResponse.json({ error: "Church and regular individual access is turned off for this service." }, { status: 403 });
        }
        if (audienceType === "church") {
          const churchAccessKey = hashChurchAccessKey(account!.profile.uid, LIVEKIT_API_SECRET);
          if (!initialPolicy.churchAccess || initialPolicy.blockedChurchAccessKeys.includes(churchAccessKey)) {
            return NextResponse.json({ error: "Church access is paused for this service. Ask the Zonal Church for help." }, { status: 403 });
          }
        } else if (audienceType === "individual" && !initialPolicy.individualAccess) {
          return NextResponse.json({ error: "Regular individual access is paused. Use a special-access code if you have one." }, { status: 403 });
        }
      }
    }

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: participantName,
      metadata: JSON.stringify({
        audienceType,
        specialAccessCodeId: specialCodeId ?? null,
        developerSpecialAccessCodeId: developerSpecialAccessCodeId ?? null,
        accountUid: developerPreview ? "developer-owner" : role === "host" ? studioOperator?.uid ?? null : account?.profile.uid ?? null,
        churchAccessKey: role === "viewer" && audienceType === "church" && account
          ? hashChurchAccessKey(account.profile.uid, LIVEKIT_API_SECRET)
          : null,
        developerPreview,
      }),
      ttl: role === "host" ? "24h" : "60s",
    });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: role === "host",
      canSubscribe: true,
      canPublishData: role === "host",
    });

    if (developerPreview) {
      await getFirebaseAdmin().firestore.collection("developerAuditLog").add({ action: "developer_preview_join", roomName, at: new Date().toISOString() }).catch(() => undefined);
      await recordPlatformActivity({ action: "developer_preview_join", label: "Developer Space opened a private live preview", actorType: "developer", actorName: "ZoneStream Developer", roomName });
    }
    return NextResponse.json({ serverUrl: LIVEKIT_URL, participantToken: await token.toJwt() });
  } catch {
    return NextResponse.json({ error: "We could not check this room’s access settings. Please try again." }, { status: 502 });
  }
}
