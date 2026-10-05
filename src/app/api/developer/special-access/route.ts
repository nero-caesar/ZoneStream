import { randomInt, randomUUID } from "node:crypto";
import { RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { verifyDeveloperRequest } from "../../../../lib/auth/developer-space";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { disconnectRoomParticipants } from "../../../../lib/stream/disconnect-participants";
import {
  decryptSpecialAccessCode,
  encryptSpecialAccessCode,
} from "../../../../lib/stream/special-access-crypto";
import {
  developerSpecialAccessCodeHash,
  developerSpecialAccessCollectionName,
  listDeveloperSpecialAccessCodes,
} from "../../../../lib/stream/developer-special-access";

export const runtime = "nodejs";

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LIMIT = 100;

function generateCode(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

export async function GET(request: NextRequest) {
  if (!await verifyDeveloperRequest(request)) return NextResponse.json({ error: "Sign in to Developer Space." }, { status: 401 });
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_API_SECRET) return NextResponse.json({ error: "Special access is not available right now." }, { status: 503 });

  try {
    const [codes, currentProgram] = await Promise.all([
      listDeveloperSpecialAccessCodes(),
      getFirebaseAdmin().firestore.collection("programs").doc("current").get(),
    ]);
    const roomName = typeof currentProgram.get("roomName") === "string" ? currentProgram.get("roomName") as string : "";
    let connectedCodeIds = new Set<string>();
    if (roomName && LIVEKIT_URL && LIVEKIT_API_KEY) {
      const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
      const [activeRoom] = await roomService.listRooms([roomName]);
      if (activeRoom) {
        const participants = await roomService.listParticipants(roomName);
        connectedCodeIds = new Set(participants.flatMap((participant) => {
          try {
            const metadata = JSON.parse(participant.metadata ?? "{}") as { developerSpecialAccessCodeId?: unknown };
            return typeof metadata.developerSpecialAccessCodeId === "string" ? [metadata.developerSpecialAccessCodeId] : [];
          } catch {
            return [];
          }
        }));
      }
    }

    return NextResponse.json({
      codes: codes.map((record) => ({
        id: record.id,
        mode: record.mode,
        code: decryptSpecialAccessCode(record.encryptedCode, LIVEKIT_API_SECRET) ?? "••••••",
        enabled: record.enabled,
        createdAt: record.createdAt,
        connected: connectedCodeIds.has(record.id),
        ...(record.redeemedBy ? { redeemedBy: record.redeemedBy } : {}),
      })),
      currentRoomName: roomName || null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Developer special-access codes could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please manage special access from Developer Space." }, { status: 403 });
  if (!await verifyDeveloperRequest(request)) return NextResponse.json({ error: "Sign in to Developer Space." }, { status: 401 });

  let body: { action?: unknown; mode?: unknown; codeId?: unknown; enabled?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Choose a special-access action." }, { status: 400 });
  }

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_API_SECRET) return NextResponse.json({ error: "Special access is not available right now." }, { status: 503 });
  const collection = getFirebaseAdmin().firestore.collection(developerSpecialAccessCollectionName());

  try {
    if (body.action === "create") {
      if (body.mode !== "temporal" && body.mode !== "permanent") return NextResponse.json({ error: "Choose temporal or permanent access." }, { status: 400 });
      const existing = await listDeveloperSpecialAccessCodes();
      if (existing.length >= CODE_LIMIT) return NextResponse.json({ error: "Developer Space has reached its 100-code limit." }, { status: 409 });

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const code = generateCode();
        const codeHash = developerSpecialAccessCodeHash(code, LIVEKIT_API_SECRET);
        const duplicate = await collection.where("codeHash", "==", codeHash).limit(1).get();
        if (!duplicate.empty) continue;
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        await collection.doc(id).create({
          mode: body.mode,
          codeHash,
          encryptedCode: encryptSpecialAccessCode(code, LIVEKIT_API_SECRET),
          enabled: true,
          createdAt,
        });
        await recordPlatformActivity({
          action: "developer_special_access_created",
          label: `Developer Space created a ${body.mode} special-access code`,
          actorType: "developer",
          actorName: "ZoneStream Developer",
        });
        return NextResponse.json({ code: { id, mode: body.mode, code, enabled: true, createdAt, connected: false } }, { status: 201 });
      }
      return NextResponse.json({ error: "A unique code could not be created. Please try again." }, { status: 503 });
    }

    if (body.action === "set-enabled") {
      const codeId = typeof body.codeId === "string" ? body.codeId : "";
      if (!/^[a-f0-9-]{36}$/i.test(codeId) || typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "Choose a code and whether it should be on or off." }, { status: 400 });
      }
      const code = await collection.doc(codeId).get();
      if (!code.exists || (code.get("mode") !== "temporal" && code.get("mode") !== "permanent")) {
        return NextResponse.json({ error: "That Developer special-access code was not found." }, { status: 404 });
      }
      await collection.doc(codeId).update({ enabled: body.enabled, updatedAt: new Date().toISOString() });

      let warning: string | undefined;
      if (!body.enabled) {
        const currentProgram = await getFirebaseAdmin().firestore.collection("programs").doc("current").get();
        const roomName = currentProgram.get("roomName");
        if (typeof roomName === "string") {
          if (LIVEKIT_URL && LIVEKIT_API_KEY) {
            try {
              const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
              const disconnected = await disconnectRoomParticipants(roomService, roomName, (participant) => {
                try {
                  const metadata = JSON.parse(participant.metadata ?? "{}") as { developerSpecialAccessCodeId?: unknown };
                  return metadata.developerSpecialAccessCodeId === codeId;
                } catch {
                  return false;
                }
              });
              if (disconnected.remainingCount > 0) warning = "The code is off, but its current connection could not be stopped yet. Retry turning it off.";
            } catch {
              warning = "The code is off for new joins, but its current connection could not be stopped yet.";
            }
          } else {
            warning = "The code is off for new joins. The live connection could not be reached to stop it.";
          }
        }
      }

      await recordPlatformActivity({
        action: body.enabled ? "developer_special_access_enabled" : "developer_special_access_disabled",
        label: `Developer Space turned a special-access code ${body.enabled ? "on" : "off"}`,
        actorType: "developer",
        actorName: "ZoneStream Developer",
        subjectId: codeId,
      });
      return NextResponse.json({ enabled: body.enabled, ...(warning ? { warning } : {}) });
    }

    return NextResponse.json({ error: "Choose a valid special-access action." }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "The Developer special-access change could not be saved." }, { status: 503 });
  }
}
