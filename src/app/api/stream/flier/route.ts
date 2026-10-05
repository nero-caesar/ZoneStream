import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { getRequestAccount } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { verifyDeveloperRequest } from "../../../../lib/auth/developer-space";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { createR2UploadSession, getR2Object, getR2ObjectMetadata, isR2StorageConfigured, removeR2Upload } from "../../../../lib/recordings/r2-storage";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";

export const runtime = "nodejs";

const MAX_FLIER_SIZE = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function validRoomName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{5,79}$/i.test(value);
}

function safeFileName(value: unknown): string {
  if (typeof value !== "string") return "service-flier";
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 120);
  return cleaned || "service-flier";
}

type FlierPayload = { action?: unknown; roomName?: unknown; fileName?: unknown; mimeType?: unknown; sizeBytes?: unknown; objectKey?: unknown };

async function activeProgram(roomName: string) {
  const { firestore } = getFirebaseAdmin();
  const programRef = firestore.collection("programs").doc("current");
  const program = await programRef.get();
  if (!program.exists || program.data()?.roomName !== roomName) return null;
  return { firestore, programRef, program: program.data() ?? {} };
}

export async function GET(request: NextRequest) {
  const account = await getRequestAccount(request);
  const developer = await verifyDeveloperRequest(request);
  if (!account && !developer) return NextResponse.json({ error: "Sign in to view the service flier." }, { status: 401 });
  if (account?.profile.role === "zonal" && !developer && !(await getStudioOperator(request))) {
    return NextResponse.json({ error: "Sign in to view the service flier." }, { status: 403 });
  }
  if (!isR2StorageConfigured()) return NextResponse.json({ error: "The service flier is not available." }, { status: 503 });

  const roomName = request.nextUrl.searchParams.get("roomName");
  const requestedKey = request.nextUrl.searchParams.get("key");
  if (!validRoomName(roomName) || !requestedKey) return NextResponse.json({ error: "That service flier link is not valid." }, { status: 400 });
  try {
    const active = await activeProgram(roomName);
    const flier = active?.program.serviceFlier;
    if (!flier || flier.objectKey !== requestedKey || typeof flier.mimeType !== "string" || !IMAGE_TYPES.has(flier.mimeType)) {
      return NextResponse.json({ error: "This service flier is no longer available." }, { status: 404 });
    }
    const image = await getR2Object(flier.objectKey);
    if (!image.Body || (typeof image.ContentLength === "number" && image.ContentLength > MAX_FLIER_SIZE)) {
      return NextResponse.json({ error: "This service flier is too large or unavailable." }, { status: 404 });
    }
    const bytes = await image.Body.transformToByteArray();
    if (!bytes.byteLength || bytes.byteLength > MAX_FLIER_SIZE) {
      return NextResponse.json({ error: "This service flier is too large or unavailable." }, { status: 404 });
    }
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": flier.mimeType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "The service flier could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Manage the service flier from ZoneStream Studio." }, { status: 403 });
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the Studio to manage the service flier." }, { status: 403 });
  if (!isR2StorageConfigured()) return NextResponse.json({ error: "Shared file storage is not available right now." }, { status: 503 });

  let body: FlierPayload;
  try {
    body = await request.json() as FlierPayload;
  } catch {
    return NextResponse.json({ error: "This service-flier request is not valid." }, { status: 400 });
  }
  if (!validRoomName(body.roomName)) return NextResponse.json({ error: "That live service link is not valid." }, { status: 400 });

  try {
    const active = await activeProgram(body.roomName);
    if (!active) return NextResponse.json({ error: "This live service has ended." }, { status: 404 });

    if (body.action === "prepare") {
      const mimeType = typeof body.mimeType === "string" ? body.mimeType.toLowerCase() : "";
      const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : 0;
      if (!IMAGE_TYPES.has(mimeType) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_FLIER_SIZE) {
        return NextResponse.json({ error: "Choose a PNG, JPG, or WebP image up to 8 MB." }, { status: 400 });
      }
      const objectKey = `service-fliers/${operator.uid}/${body.roomName}/${randomUUID()}`;
      const upload = await createR2UploadSession(objectKey, mimeType, sizeBytes);
      if (upload.mode !== "single") {
        await removeR2Upload(objectKey, upload.mode === "multipart" ? upload.uploadId : undefined);
        return NextResponse.json({ error: "This service flier is too large to upload." }, { status: 400 });
      }
      return NextResponse.json({ objectKey, uploadUrl: upload.uploadUrl }, { status: 201, headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "complete") {
      const objectKey = typeof body.objectKey === "string" ? body.objectKey : "";
      const fileName = safeFileName(body.fileName);
      const expectedPrefix = `service-fliers/${operator.uid}/${body.roomName}/`;
      const mimeType = typeof body.mimeType === "string" ? body.mimeType.toLowerCase() : "";
      const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : 0;
      if (!objectKey.startsWith(expectedPrefix) || !/^[a-f0-9-]{36}$/i.test(objectKey.slice(expectedPrefix.length)) || !IMAGE_TYPES.has(mimeType) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_FLIER_SIZE) {
        return NextResponse.json({ error: "The uploaded service flier is not valid." }, { status: 400 });
      }
      const metadata = await getR2ObjectMetadata(objectKey);
      const receivedType = metadata.ContentType?.toLowerCase() ?? "";
      const receivedSize = metadata.ContentLength ?? 0;
      if (!IMAGE_TYPES.has(receivedType) || receivedType !== mimeType || receivedSize !== sizeBytes || receivedSize > MAX_FLIER_SIZE) {
        await removeR2Upload(objectKey);
        return NextResponse.json({ error: "The complete image could not be verified. Please upload it again." }, { status: 400 });
      }

      const previousKey = typeof active.program.serviceFlier?.objectKey === "string" ? active.program.serviceFlier.objectKey : "";
      const flier = { objectKey, fileName, mimeType: receivedType, sizeBytes: receivedSize, uploadedAt: new Date().toISOString() };
      await active.programRef.update({ serviceFlier: flier });
      if (previousKey && previousKey !== objectKey) await removeR2Upload(previousKey).catch(() => undefined);
      await recordPlatformActivity({ action: "service_flier_uploaded", label: `${operator.displayName} uploaded the service flier`, actorType: operator.kind, actorName: operator.displayName, subjectName: fileName, roomName: body.roomName });
      return NextResponse.json({ flier }, { status: 201, headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "remove") {
      const previousKey = typeof active.program.serviceFlier?.objectKey === "string" ? active.program.serviceFlier.objectKey : "";
      await active.programRef.update({ serviceFlier: null, activeSourceMode: "studio", activeSourceInviteId: null, activeSourceUpdatedAt: new Date().toISOString() });
      if (previousKey) await removeR2Upload(previousKey).catch(() => undefined);
      await recordPlatformActivity({ action: "service_flier_removed", label: `${operator.displayName} removed the service flier`, actorType: operator.kind, actorName: operator.displayName, roomName: body.roomName });
      return NextResponse.json({ removed: true });
    }

    return NextResponse.json({ error: "Choose upload completion or flier removal." }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "ZoneStream could not update the service flier." }, { status: 503 });
  }
}
