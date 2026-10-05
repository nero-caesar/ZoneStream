import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { createR2UploadSession, isR2StorageConfigured, removeR2Upload } from "../../../../lib/recordings/r2-storage";

export const runtime = "nodejs";

type UploadRequest = {
  id?: unknown;
  title?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
};

const MAX_RECORDING_SIZE = 4 * 1024 ** 4;

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Please upload recordings from the ZoneStream website." }, { status: 403 });
  }

  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to upload shared recordings." }, { status: 403 });
  if (!isR2StorageConfigured()) {
    return NextResponse.json({ error: "Shared video uploads are not available right now. Please try again later." }, { status: 503 });
  }

  let body: UploadRequest;
  try {
    body = await request.json() as UploadRequest;
  } catch {
    return NextResponse.json({ error: "Please provide the video details." }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const fileName = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 240) : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType.trim().toLowerCase() : "";
  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : 0;

  if (
    !/^[a-f0-9-]{36}$/i.test(id) ||
    !title ||
    title.length > 120 ||
    !fileName ||
    !mimeType.startsWith("video/") ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_RECORDING_SIZE
  ) {
    return NextResponse.json({ error: "Choose a valid video file up to 4 TiB." }, { status: 400 });
  }

  const objectKey = "recordings/" + operator.uid + "/" + id;
  let uploadId: string | undefined;

  try {
    const upload = await createR2UploadSession(objectKey, mimeType, sizeBytes);
    if (upload.mode === "multipart") uploadId = upload.uploadId;

    try {
      await getFirebaseAdmin().firestore.collection("recordings").doc(id).create({
        title,
        fileName,
        mimeType,
        sizeBytes,
        objectKey,
        storageProvider: "r2",
        multipartUploadId: uploadId ?? null,
        multipartPartSizeBytes: upload.mode === "multipart" ? upload.partSizeBytes : null,
        uploadedBy: operator.uid,
        uploadedByName: operator.displayName,
        status: "uploading",
        createdAtMs: Date.now(),
      });
    } catch (error) {
      await removeR2Upload(objectKey, uploadId);
      throw error;
    }

    return NextResponse.json({ id, objectKey, ...upload }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "ZoneStream could not prepare a secure video upload. Please try again." }, { status: 503 });
  }
}
