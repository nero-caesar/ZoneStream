import { randomInt, randomUUID } from "node:crypto";
import { RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";
import { disconnectRoomParticipants } from "../../../../lib/stream/disconnect-participants";
import {
  getPublicSpecialAccessCodes,
  parseStreamAccessPolicy,
  serializeStreamAccessPolicy,
  type StreamAccessPolicy,
} from "../../../../lib/stream/access-policy";
import {
  decryptPrivateSpecialAccessState,
  decryptSpecialAccessCode,
  encryptPrivateSpecialAccessState,
  encryptSpecialAccessCode,
  hashChurchAccessKey,
  hashSpecialAccessCode,
} from "../../../../lib/stream/special-access-crypto";

export const runtime = "nodejs";

type AccessAction = "get-state" | "set-all-access" | "set-church-access" | "set-church-account-access" | "set-individual-access" | "set-special-access" | "generate-code" | "set-code-access" | "enforce-access";

type AccessRequest = {
  roomName?: unknown;
  action?: unknown;
  allAccess?: unknown;
  churchAccess?: unknown;
  individualAccess?: unknown;
  specialAccess?: unknown;
  codeId?: unknown;
  churchUid?: unknown;
  enabled?: unknown;
};

type ParticipantInfo = {
  identity: string;
  metadata?: string;
};

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function isValidRoomName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{5,79}$/i.test(value);
}

function getParticipantMetadata(metadata?: string): { audienceType?: unknown; specialAccessCodeId?: unknown; developerSpecialAccessCodeId?: unknown; accountUid?: unknown; churchAccessKey?: unknown } {
  try {
    const parsed: unknown = JSON.parse(metadata ?? "{}");
    return parsed && typeof parsed === "object"
      ? parsed as { audienceType?: unknown; specialAccessCodeId?: unknown; developerSpecialAccessCodeId?: unknown; accountUid?: unknown; churchAccessKey?: unknown }
      : {};
  } catch {
    return {};
  }
}

function shouldDisconnectParticipant(
  participant: ParticipantInfo,
  policy: StreamAccessPolicy,
  targetedCodeId?: string,
  targetedChurchUid?: string,
): boolean {
  if (!participant.identity.startsWith("viewer-")) return false;

  const metadata = getParticipantMetadata(participant.metadata);
  if (typeof metadata.developerSpecialAccessCodeId === "string") return false;
  const specialCodeId = typeof metadata.specialAccessCodeId === "string" ? metadata.specialAccessCodeId : undefined;

  if (specialCodeId) {
    if (targetedCodeId) return specialCodeId === targetedCodeId;
    const code = policy.specialAccessCodes.find((entry) => entry.id === specialCodeId);
    return !policy.specialAccess || !code || !code.enabled;
  }

  if (targetedCodeId) return false;
  if (targetedChurchUid) return metadata.audienceType === "church" && metadata.accountUid === targetedChurchUid;
  if (!policy.allAccess) return true;
  if (metadata.audienceType === "church") {
    return !policy.churchAccess ||
      (typeof metadata.churchAccessKey === "string" && policy.blockedChurchAccessKeys.includes(metadata.churchAccessKey));
  }
  return metadata.audienceType === "individual" && !policy.individualAccess;
}

function policyResponse(policy: StreamAccessPolicy, secret: string, participants: ParticipantInfo[], generatedCode?: string, platformViewerPaused = false) {
  const connectedIdentities = new Set(participants.map((participant) => participant.identity));
  const decryptedCodes = new Map<string, string>();
  for (const entry of policy.specialAccessCodes) {
    const code = decryptSpecialAccessCode(entry.encryptedCode, secret);
    if (code) decryptedCodes.set(entry.id, code);
  }

  return {
    allAccess: policy.allAccess,
    churchAccess: policy.churchAccess,
    individualAccess: policy.individualAccess,
    specialAccess: policy.specialAccess,
    platformViewerPaused,
    specialAccessCodes: getPublicSpecialAccessCodes(policy, decryptedCodes, connectedIdentities),
    ...(generatedCode ? { generatedCode } : {}),
  };
}

function generateCode(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

function hasEncryptedCodeState(metadata?: string): boolean {
  try {
    const parsed: unknown = JSON.parse(metadata ?? "{}");
    if (!parsed || typeof parsed !== "object") return false;
    const policy = (parsed as Record<string, unknown>).zoneStreamAccess;
    return Boolean(policy && typeof policy === "object" && typeof (policy as Record<string, unknown>).encryptedSpecialAccessCodes === "string");
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please manage stream access from ZoneStream." }, { status: 403 });
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to manage stream access." }, { status: 403 });

  let body: AccessRequest;

  try {
    body = (await request.json()) as AccessRequest;
  } catch {
    return NextResponse.json({ error: "Please send a valid access update." }, { status: 400 });
  }

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json({ error: "The streaming service is not configured for access controls." }, { status: 503 });
  }

  if (!isValidRoomName(body.roomName)) {
    return NextResponse.json({ error: "That stream link is not valid." }, { status: 400 });
  }

  const actions: AccessAction[] = ["get-state", "set-all-access", "set-church-access", "set-church-account-access", "set-individual-access", "set-special-access", "generate-code", "set-code-access", "enforce-access"];
  if (!actions.includes(body.action as AccessAction)) {
    return NextResponse.json({ error: "Choose a valid access update." }, { status: 400 });
  }

  try {
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const [activeRoom] = await roomService.listRooms([body.roomName]);
    if (!activeRoom) {
      return NextResponse.json({ error: "This live service is no longer active." }, { status: 404 });
    }

    const action = body.action as AccessAction;
    const decryptCodes = (encrypted: string) => decryptPrivateSpecialAccessState(encrypted, LIVEKIT_API_SECRET);
    const policy = parseStreamAccessPolicy(activeRoom.metadata, decryptCodes);
    const platformControls = await getFirebaseAdmin().firestore.collection("platformControl").doc("access").get();
    const platformViewerPaused = platformControls.exists && platformControls.get("viewerPaused") === true;
    let generatedCode: string | undefined;
    let targetedCodeId: string | undefined;
    let targetedChurchUid: string | undefined;
    let disconnectWarning: string | undefined;

    if (action === "set-all-access") {
      if (typeof body.allAccess !== "boolean") {
        return NextResponse.json({ error: "Choose whether church and regular individual access should be open." }, { status: 400 });
      }
      policy.allAccess = body.allAccess;
    } else if (action === "set-church-access") {
      if (typeof body.churchAccess !== "boolean") {
        return NextResponse.json({ error: "Choose whether all church accounts should be able to join." }, { status: 400 });
      }
      policy.churchAccess = body.churchAccess;
    } else if (action === "set-church-account-access") {
      const churchUid = typeof body.churchUid === "string" ? body.churchUid : "";
      if (!/^[a-f0-9-]{36}$/i.test(churchUid) || typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "Choose a registered church and its access setting." }, { status: 400 });
      }
      const churchSnapshot = await getFirebaseAdmin().firestore.collection("accounts").doc(churchUid).get();
      if (!churchSnapshot.exists || churchSnapshot.get("role") !== "church") {
        return NextResponse.json({ error: "That registered church was not found." }, { status: 404 });
      }
      const key = hashChurchAccessKey(churchUid, LIVEKIT_API_SECRET);
      policy.blockedChurchAccessKeys = body.enabled
        ? policy.blockedChurchAccessKeys.filter((entry) => entry !== key)
        : Array.from(new Set([...policy.blockedChurchAccessKeys, key]));
      targetedChurchUid = body.enabled ? undefined : churchUid;
    } else if (action === "set-individual-access") {
      if (typeof body.individualAccess !== "boolean") {
        return NextResponse.json({ error: "Choose whether regular individual access should be open." }, { status: 400 });
      }
      policy.individualAccess = body.individualAccess;
    } else if (action === "set-special-access") {
      if (typeof body.specialAccess !== "boolean") {
        return NextResponse.json({ error: "Choose whether special access should be open." }, { status: 400 });
      }
      policy.specialAccess = body.specialAccess;
    } else if (action === "generate-code") {
      if (policy.specialAccessCodes.length >= 100) {
        return NextResponse.json({ error: "This live service has reached its special-code limit." }, { status: 409 });
      }

      let code = generateCode();
      while (policy.specialAccessCodes.some((entry) => entry.codeHash === hashSpecialAccessCode(code, LIVEKIT_API_SECRET))) {
        code = generateCode();
      }
      generatedCode = code;
      policy.specialAccessCodes.push({
        id: randomUUID(),
        codeHash: hashSpecialAccessCode(code, LIVEKIT_API_SECRET),
        encryptedCode: "",
        enabled: true,
      });
      // The encrypted code is stored before the policy reaches LiveKit metadata.
      const createdCode = policy.specialAccessCodes.at(-1)!;
      createdCode.encryptedCode = encryptSpecialAccessCode(code, LIVEKIT_API_SECRET);
    } else if (action === "set-code-access") {
      const codeId = typeof body.codeId === "string" ? body.codeId : "";
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "Choose whether this special code should be on or off." }, { status: 400 });
      }
      const code = policy.specialAccessCodes.find((entry) => entry.id === codeId);
      if (!code || !code.redeemedBy) {
        return NextResponse.json({ error: "That used special-access code was not found." }, { status: 404 });
      }
      code.enabled = body.enabled;
      targetedCodeId = body.enabled ? undefined : code.id;
    } else if (action === "enforce-access") {
      targetedCodeId = typeof body.codeId === "string" ? body.codeId : undefined;
    }

    const retryDisconnect = action === "enforce-access";
    if (!retryDisconnect && action !== "get-state") {
      await roomService.updateRoomMetadata(
        body.roomName,
        serializeStreamAccessPolicy(policy, encryptPrivateSpecialAccessState(policy.specialAccessCodes, LIVEKIT_API_SECRET), platformViewerPaused),
      );
    } else if (action === "get-state" && !hasEncryptedCodeState(activeRoom.metadata)) {
      // Upgrade existing pilot rooms the first time the host opens the controls.
      await roomService.updateRoomMetadata(
        body.roomName,
        serializeStreamAccessPolicy(policy, encryptPrivateSpecialAccessState(policy.specialAccessCodes, LIVEKIT_API_SECRET), platformViewerPaused),
      );
    }

    const shouldEnforce =
      retryDisconnect ||
      (action === "set-all-access" && body.allAccess === false) ||
      (action === "set-church-access" && body.churchAccess === false) ||
      (action === "set-church-account-access" && body.enabled === false) ||
      (action === "set-individual-access" && body.individualAccess === false) ||
      (action === "set-special-access" && body.specialAccess === false) ||
      (action === "set-code-access" && body.enabled === false);

    let participants = await roomService.listParticipants(body.roomName);
    if (shouldEnforce) {
      const result = await disconnectRoomParticipants(roomService, body.roomName, (participant) =>
        shouldDisconnectParticipant(participant, policy, targetedCodeId, targetedChurchUid),
      );
      participants = await roomService.listParticipants(body.roomName);
      if (result.remainingCount > 0) {
        disconnectWarning = targetedCodeId
          ? "We could not disconnect that special-access guest. Please try again."
          : !policy.specialAccess
            ? "Some special-access guests are still connected. Please retry the disconnect."
          : targetedChurchUid || !policy.churchAccess
            ? "Some church accounts are still connected. Please retry the disconnect."
            : !policy.allAccess
              ? "Some regular audience members are still connected. Please retry the disconnect."
              : !policy.individualAccess
                ? "Some regular individuals are still connected. Please retry the disconnect."
                : "Some blocked audience members are still connected. Please retry the disconnect.";
      }
    }

    if (action !== "get-state") {
      const activityLabels: Record<AccessAction, string> = {
        "get-state": "",
        "set-church-access": "All church access was turned " + (policy.churchAccess ? "on" : "off"),
        "set-church-account-access": "A church account’s live access was turned " + (body.enabled ? "on" : "off"),
        "set-all-access": `Church and regular individual access was turned ${policy.allAccess ? "on" : "off"}`,
        "set-individual-access": `Regular individual access was turned ${policy.individualAccess ? "on" : "off"}`,
        "set-special-access": `All special access was turned ${policy.specialAccess ? "on" : "off"}`,
        "generate-code": "A special-access code was generated",
        "set-code-access": `Special access for ${policy.specialAccessCodes.find((entry) => entry.id === (typeof body.codeId === "string" ? body.codeId : ""))?.redeemedBy?.name ?? "a guest"} was turned ${body.enabled ? "on" : "off"}`,
        "enforce-access": "The studio retried disconnecting blocked attendees",
      };
      await recordPlatformActivity({ action: `studio_${action.replaceAll("-", "_")}`, label: `${operator.displayName}: ${activityLabels[action] || "Updated live access settings"}`, actorType: operator.kind, actorName: operator.displayName, roomName: body.roomName });
    }

    return NextResponse.json({
      ...policyResponse(policy, LIVEKIT_API_SECRET, participants, generatedCode, platformViewerPaused),
      ...(disconnectWarning ? { warning: disconnectWarning } : {}),
      ...(disconnectWarning && targetedCodeId ? { retryCodeId: targetedCodeId } : {}),
    });
  } catch {
    return NextResponse.json({ error: "We could not update this room’s access settings. Please try again." }, { status: 502 });
  }
}
