import { NextRequest, NextResponse } from "next/server";
import { getRequestAccount, isSameOriginRequest } from "../../../lib/auth/server";
import { getStudioOperator } from "../../../lib/auth/studio-operator";
import { recordPlatformActivity } from "../../../lib/audit/platform-activity";
import { getFirebaseAdmin } from "../../../lib/firebase/admin";
import { sendIndividualNotification } from "../../../lib/notifications/send";
import {
  completeR2MultipartUpload,
  createR2DownloadUrl,
  getR2ObjectMetadata,
  isR2StorageConfigured,
  removeR2Upload,
} from "../../../lib/recordings/r2-storage";

export const runtime = "nodejs";

type PublishPayload = { id?: unknown };
type StudioRecording = {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  downloadUrl: string;
};

export async function GET(request: NextRequest) {
  const operator = await getStudioOperator(request);
  const account = operator ? null : await getRequestAccount(request);
  if (!account && !operator) return NextResponse.json({ error: "Sign in to view recorded messages." }, { status: 401 });

  if (!isR2StorageConfigured()) {
    return NextResponse.json({ sharedStorageAvailable: false, recordings: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const { firestore } = getFirebaseAdmin();
    const snapshot = await firestore.collection("recordings").orderBy("createdAtMs", "desc").limit(80).get();
    const recordings = await Promise.all(snapshot.docs.flatMap((document) => {
      const data = document.data();
      if (data.status !== "ready" || data.storageProvider !== "r2" || typeof data.objectKey !== "string") return [];

      return [(async () => {
        try {
          const mimeType = typeof data.mimeType === "string" && data.mimeType.startsWith("video/") ? data.mimeType : "video/mp4";
          const downloadUrl = await createR2DownloadUrl(data.objectKey, mimeType);
          return {
            id: document.id,
            title: typeof data.title === "string" ? data.title : "Recorded message",
            fileName: typeof data.fileName === "string" ? data.fileName : "service-video",
            mimeType,
            sizeBytes: typeof data.sizeBytes === "number" ? data.sizeBytes : 0,
            createdAt: typeof data.createdAtMs === "number" ? data.createdAtMs : 0,
            downloadUrl,
          };
        } catch {
          return null;
        }
      })()];
    }));

    return NextResponse.json({
      sharedStorageAvailable: true,
      recordings: recordings.filter((recording): recording is StudioRecording => recording !== null),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ sharedStorageAvailable: false, recordings: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Please upload recordings from the ZoneStream website." }, { status: 403 });
  }

  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to publish shared recordings." }, { status: 403 });
  if (!isR2StorageConfigured()) {
    return NextResponse.json({ error: "Shared video uploads are not available right now." }, { status: 503 });
  }

  let body: PublishPayload;
  try {
    body = await request.json() as PublishPayload;
  } catch {
    return NextResponse.json({ error: "Please provide the video upload ID." }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "The video upload ID is not valid." }, { status: 400 });
  }

  const recordingRef = getFirebaseAdmin().firestore.collection("recordings").doc(id);
  const recordingSnapshot = await recordingRef.get();
  if (!recordingSnapshot.exists) return NextResponse.json({ error: "This video upload has expired. Please start again." }, { status: 404 });
  const recording = recordingSnapshot.data()!;
  const expectedObjectKey = "recordings/" + operator.uid + "/" + id;
  if (
    recording.status !== "uploading" ||
    recording.storageProvider !== "r2" ||
    recording.uploadedBy !== operator.uid ||
    recording.objectKey !== expectedObjectKey ||
    typeof recording.sizeBytes !== "number" ||
    typeof recording.mimeType !== "string"
  ) {
    return NextResponse.json({ error: "This video upload is not available to publish." }, { status: 409 });
  }

  try {
    if (typeof recording.multipartUploadId === "string" && typeof recording.multipartPartSizeBytes === "number") {
      await completeR2MultipartUpload(
        expectedObjectKey,
        recording.multipartUploadId,
        recording.sizeBytes,
        recording.multipartPartSizeBytes,
      );
    }

    const objectMetadata = await getR2ObjectMetadata(expectedObjectKey);
    const actualMimeType = objectMetadata.ContentType?.toLowerCase() ?? "";
    const actualSizeBytes = objectMetadata.ContentLength ?? 0;
    if (!actualMimeType.startsWith("video/") || actualSizeBytes !== recording.sizeBytes) {
      await removeR2Upload(expectedObjectKey);
      await recordingRef.delete();
      return NextResponse.json({ error: "ZoneStream did not receive the complete video. Please upload it again." }, { status: 400 });
    }

    const createdAtMs = Date.now();
    await recordingRef.update({
      mimeType: actualMimeType,
      sizeBytes: actualSizeBytes,
      status: "ready",
      createdAt: new Date(createdAtMs),
      createdAtMs,
      multipartUploadId: null,
      multipartPartSizeBytes: null,
    });

    await recordPlatformActivity({ action: "recording_published", label: `${operator.displayName} published a recorded message: ${String(recording.title).slice(0, 120)}`, actorType: operator.kind, actorName: operator.displayName, subjectName: String(recording.title).slice(0, 120) });

    try {
      await sendIndividualNotification({
        title: "New recorded message",
        body: recording.title,
        url: "/dashboard#recorded-messages",
        kind: "recording_uploaded",
        tag: "recording-" + id,
      });
    } catch {
      // A push failure must not undo a successfully published video.
    }

    return NextResponse.json({ saved: true, id }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "The video is not available yet. Please retry the upload." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Please manage recordings from the ZoneStream website." }, { status: 403 });
  }

  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to cancel a pending upload." }, { status: 403 });

  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!/^[a-f0-9-]{36}$/i.test(id)) return NextResponse.json({ error: "The upload ID is not valid." }, { status: 400 });

  const recordingRef = getFirebaseAdmin().firestore.collection("recordings").doc(id);
  const recordingSnapshot = await recordingRef.get();
  if (!recordingSnapshot.exists) return NextResponse.json({ cancelled: true });
  const recording = recordingSnapshot.data()!;
  const uploadedBy = typeof recording.uploadedBy === "string" ? recording.uploadedBy : "";
  const expectedObjectKey = uploadedBy ? `recordings/${uploadedBy}/${id}` : "";
  const isPendingUpload = recording.status === "uploading";
  const isPublishedRecording = recording.status === "ready";
  if (
    recording.storageProvider !== "r2" ||
    !expectedObjectKey ||
    recording.objectKey !== expectedObjectKey ||
    (!isPendingUpload && !isPublishedRecording) ||
    (isPendingUpload && uploadedBy !== operator.uid)
  ) {
    return NextResponse.json({ error: isPendingUpload ? "Only your own pending upload can be cancelled." : "This video cannot be removed." }, { status: 409 });
  }

  try {
    await removeR2Upload(
      expectedObjectKey,
      isPendingUpload && typeof recording.multipartUploadId === "string" ? recording.multipartUploadId : undefined,
    );
    await recordingRef.delete();
    if (isPublishedRecording) {
      const title = typeof recording.title === "string" ? recording.title.slice(0, 120) : "Recorded message";
      await recordPlatformActivity({
        action: "recording_deleted",
        label: `${operator.displayName} removed a recorded message: ${title}`,
        actorType: operator.kind,
        actorName: operator.displayName,
        subjectName: title,
        subjectId: id,
      });
    }
    return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      error: isPublishedRecording ? "The video could not be removed from the server." : "The pending upload could not be cancelled.",
    }, { status: 503 });
  }
}
