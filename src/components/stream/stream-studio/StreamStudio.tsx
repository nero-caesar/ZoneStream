"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { FiArrowLeft, FiArrowRight, FiHardDrive, FiRadio, FiShield, FiTrash2, FiUpload, FiUsers, FiVideo } from "react-icons/fi";
import Brand from "../../brand/Brand";
import SignOutButton from "../../sign-out-button/SignOutButton";
import HistoryBackButton from "../../history-back-button/HistoryBackButton";
import ZonalPasswordRecovery from "../../zonal-password-recovery/ZonalPasswordRecovery";
import LiveRoom from "../live-room/LiveRoom";
import type { StreamSession } from "../types";
import { chooseLocalRecordingFile, prepareLocalRecordingAudioContext, type LocalRecordingFileHandle } from "../../../lib/stream/local-recording";
import "./stream-studio.css";

type R2UploadPlan = {
  id?: string;
  mode?: "single" | "multipart";
  uploadUrl?: string;
  partSizeBytes?: number;
  partUrls?: string[];
  error?: string;
};

type StudioRecording = {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  downloadUrl: string;
};

function UploadedVideoLibrary({
  recordings,
  loading,
  error,
  deletingId,
  onDelete,
}: {
  recordings: StudioRecording[];
  loading: boolean;
  error: string;
  deletingId: string;
  onDelete: (recording: StudioRecording) => void;
}) {
  const [previewingId, setPreviewingId] = useState("");

  return (
    <section className="stream-studio-library" aria-labelledby="stream-studio-library-title">
      <div className="stream-studio-library-heading">
        <div>
          <span className="stream-studio-form-eyebrow">SHARED WITH VIEWERS</span>
          <h2 id="stream-studio-library-title">Videos on the server</h2>
        </div>
        <span className="stream-studio-library-count">{recordings.length}</span>
      </div>
      <p className="stream-studio-library-description">These videos appear in Recorded Messages for individual and church viewers.</p>
      {error ? <p className="stream-studio-error" role="alert">{error}</p> : null}
      {loading ? <p className="stream-studio-library-empty">Loading uploaded videos…</p> : recordings.length ? (
        <ul className="stream-studio-library-list">
          {recordings.map((recording) => (
            <li className="stream-studio-library-item" key={recording.id}>
              <span className="stream-studio-library-video-icon"><FiVideo aria-hidden="true" /></span>
              <span className="stream-studio-library-details">
                <strong>{recording.title}</strong>
                <small>{recording.fileName} · Uploaded {recording.createdAt ? new Date(recording.createdAt).toLocaleString() : "recently"}</small>
              </span>
              <span className="stream-studio-library-status">On server</span>
              <div className="stream-studio-library-actions">
                <button
                  className="stream-studio-preview-button"
                  type="button"
                  onClick={() => setPreviewingId((current) => current === recording.id ? "" : recording.id)}
                  aria-expanded={previewingId === recording.id}
                  aria-controls={`recording-preview-${recording.id}`}
                >
                  <FiVideo aria-hidden="true" /> {previewingId === recording.id ? "Hide preview" : "Play video"}
                </button>
                <button
                  className="stream-studio-delete-button"
                  type="button"
                  onClick={() => onDelete(recording)}
                  disabled={deletingId === recording.id}
                  aria-label={`Remove ${recording.title} from the server`}
                >
                  <FiTrash2 aria-hidden="true" /> {deletingId === recording.id ? "Removing…" : "Remove"}
                </button>
              </div>
              {previewingId === recording.id ? (
                <video
                  id={`recording-preview-${recording.id}`}
                  className="stream-studio-library-preview"
                  controls
                  playsInline
                  preload="metadata"
                  aria-label={`Preview ${recording.title}`}
                >
                  <source src={recording.downloadUrl} type={recording.mimeType} />
                  Your browser cannot play this video format.
                </video>
              ) : null}
            </li>
          ))}
        </ul>
      ) : !error ? (
        <p className="stream-studio-library-empty">No videos have been uploaded yet.</p>
      ) : null}
    </section>
  );
}

function uploadBlobToR2(url: string, blob: Blob, onProgress: (loadedBytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error("ZoneStream could not save part of this video. Please try again."));
    });
    request.addEventListener("error", () => {
      reject(new Error("The video could not reach ZoneStream. Check your internet connection and try again."));
    });
    request.addEventListener("abort", () => reject(new Error("The video upload was interrupted.")));
    request.send(blob);
  });
}

async function uploadVideoToR2(plan: R2UploadPlan, file: File, onProgress: (progress: number) => void): Promise<void> {
  if (plan.mode === "single" && plan.uploadUrl) {
    await uploadBlobToR2(plan.uploadUrl, file, (loadedBytes) => {
      onProgress(Math.min(100, Math.round((loadedBytes / file.size) * 100)));
    });
    return;
  }

  if (plan.mode !== "multipart" || !plan.partSizeBytes || !plan.partUrls?.length) {
    throw new Error("ZoneStream could not prepare this video upload. Please try again.");
  }

  const partProgress = new Array<number>(plan.partUrls.length).fill(0);
  let nextPart = 0;
  let uploadFailed = false;
  const updateProgress = () => {
    const uploaded = partProgress.reduce((total, bytes) => total + bytes, 0);
    onProgress(Math.min(100, Math.round((uploaded / file.size) * 100)));
  };
  const uploadNextPart = async () => {
    while (nextPart < plan.partUrls!.length && !uploadFailed) {
      const partIndex = nextPart++;
      const start = partIndex * plan.partSizeBytes!;
      const end = Math.min(file.size, start + plan.partSizeBytes!);
      const chunk = file.slice(start, end, file.type);
      try {
        await uploadBlobToR2(plan.partUrls![partIndex], chunk, (loadedBytes) => {
          partProgress[partIndex] = loadedBytes;
          updateProgress();
        });
        partProgress[partIndex] = chunk.size;
        updateProgress();
      } catch (error) {
        uploadFailed = true;
        throw error;
      }
    }
  };

  const results = await Promise.allSettled(
    Array.from({ length: Math.min(3, plan.partUrls.length) }, () => uploadNextPart()),
  );
  const failedPart = results.find((result) => result.status === "rejected");
  if (failedPart?.status === "rejected") throw failedPart.reason;
}

export default function StreamStudio({ zonalName, developerMode = false }: { zonalName: string; developerMode?: boolean }) {
  const [session, setSession] = useState<StreamSession | null>(null);
  const [leaveActiveBroadcast, setLeaveActiveBroadcast] = useState<(() => Promise<boolean>) | null>(null);
  const [studioMode, setStudioMode] = useState<"choose" | "stream" | "upload">("choose");
  const [title, setTitle] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [recordingToast, setRecordingToast] = useState("");
  const [recordingFileHandle, setRecordingFileHandle] = useState<LocalRecordingFileHandle | null>(null);
  const [recordingAudioContext, setRecordingAudioContext] = useState<AudioContext | null>(null);
  const [sharedStorageAvailable, setSharedStorageAvailable] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [uploadMessage, setUploadMessage] = useState("");
  const [studioRecordings, setStudioRecordings] = useState<StudioRecording[]>([]);
  const [recordingsLoading, setRecordingsLoading] = useState(true);
  const [recordingsError, setRecordingsError] = useState("");
  const [deletingRecordingId, setDeletingRecordingId] = useState("");

  const registerHostLeave = useCallback((leave: (() => Promise<boolean>) | null) => {
    setLeaveActiveBroadcast(() => leave);
  }, []);

  const handleHostRoomLeave = useCallback(() => {
    setSession(null);
    setRecordingFileHandle(null);
    setStudioMode("choose");
  }, []);

  const refreshStudioRecordings = useCallback(async () => {
    setRecordingsLoading(true);
    try {
      const response = await fetch("/api/recordings", { cache: "no-store" });
      const result = await response.json() as { error?: string; sharedStorageAvailable?: boolean; recordings?: StudioRecording[] };
      if (!response.ok) throw new Error(result.error ?? "The uploaded videos could not be loaded.");
      setSharedStorageAvailable(result.sharedStorageAvailable === true);
      setStudioRecordings(result.recordings ?? []);
      setRecordingsError("");
    } catch {
      setSharedStorageAvailable(false);
      setRecordingsError("The uploaded videos could not be loaded. Please refresh and try again.");
    } finally {
      setRecordingsLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refreshStudioRecordings(), 0);
    return () => window.clearTimeout(initialLoad);
  }, [refreshStudioRecordings]);

  useEffect(() => {
    if (!recordingToast) return;
    const timeout = window.setTimeout(() => setRecordingToast(""), 6500);
    return () => window.clearTimeout(timeout);
  }, [recordingToast]);

  const activeRoomName = session?.roomName;
  const notifyViewersThatStreamStarted = useCallback(() => {
    if (!activeRoomName) return;
    void fetch("/api/notifications/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "stream_started", roomName: activeRoomName }),
    }).catch(() => undefined);
  }, [activeRoomName]);

  async function startBroadcast(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setStarting(true);

    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError("Add a program title to continue.");
      setStarting(false);
      return;
    }

    const roomName = `zonestream-${window.crypto.randomUUID().slice(0, 12)}`;
    const shareUrl = `${window.location.origin}/stream/watch/${roomName}?title=${encodeURIComponent(cleanTitle)}`;
    const preparedAudioContext = prepareLocalRecordingAudioContext();
    try {
      let selectedRecordingFile: LocalRecordingFileHandle | null = null;
      let recordingNotice = "";
      try {
        selectedRecordingFile = await chooseLocalRecordingFile(cleanTitle);
      } catch (pickerError) {
        if (pickerError instanceof DOMException && pickerError.name === "AbortError") throw pickerError;
        recordingNotice = "Your browser could not open the save-location picker. The recording will download to this device when it stops.";
      }
      const response = await fetch("/api/zonal/program", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, title: cleanTitle, shareUrl }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not start the live service.");
      setRecordingFileHandle(selectedRecordingFile);
      setRecordingAudioContext(preparedAudioContext);
      if (recordingNotice) setRecordingToast(recordingNotice);
      setSession({ roomName, title: cleanTitle, participantName: zonalName, shareUrl });
    } catch (startError) {
      if (preparedAudioContext && preparedAudioContext.state !== "closed") {
        void preparedAudioContext.close().catch(() => undefined);
      }
      if (startError instanceof DOMException && startError.name === "AbortError") return;
      setError(startError instanceof Error ? startError.message : "Could not start the live service.");
    } finally {
      setStarting(false);
    }
  }

  async function uploadPreparedVideo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploadError("");
    setUploadMessage("");
    setUploadProgress(0);
    if (!uploadFile) {
      setUploadError("Choose a video file to upload.");
      return;
    }
    if (!uploadFile.type.startsWith("video/")) {
      setUploadError("Choose a video file, such as MP4 or WebM.");
      return;
    }
    if (!sharedStorageAvailable) {
      setUploadError("Shared video uploads are not available right now. Please try again later.");
      return;
    }

    const cleanTitle = uploadTitle.trim() || uploadFile.name.replace(/\.[^.]+$/, "");
    const recordingId = window.crypto.randomUUID();
    setUploading(true);

    try {
      const uploadUrlResponse = await fetch("/api/recordings/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: recordingId,
          title: cleanTitle,
          fileName: uploadFile.name,
          mimeType: uploadFile.type,
          sizeBytes: uploadFile.size,
        }),
      });
      const uploadPlan = await uploadUrlResponse.json() as R2UploadPlan;
      if (!uploadUrlResponse.ok) throw new Error(uploadPlan.error ?? "ZoneStream could not prepare the video upload.");

      await uploadVideoToR2(uploadPlan, uploadFile, setUploadProgress);

      const publishResponse = await fetch("/api/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: recordingId }),
      });
      const publishResult = await publishResponse.json() as { error?: string };
      if (!publishResponse.ok) throw new Error(publishResult.error ?? "The video uploaded, but it could not be published to Recorded Messages.");

      setUploadMessage(`“${cleanTitle}” is now uploaded to the server and available in Recorded Messages for individual and church viewers.`);
      await refreshStudioRecordings();
      setUploadFile(null);
      setUploadTitle("");
      const fileInput = document.getElementById("recording-video-file") as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";
    } catch (uploadFailure) {
      await fetch("/api/recordings?id=" + encodeURIComponent(recordingId), { method: "DELETE" }).catch(() => undefined);
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : "The video could not be saved. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function removeUploadedVideo(recording: StudioRecording) {
    const confirmed = window.confirm(`Remove “${recording.title}” from the server? Viewers will no longer see or play it.`);
    if (!confirmed) return;
    setDeletingRecordingId(recording.id);
    setRecordingsError("");
    try {
      const response = await fetch(`/api/recordings?id=${encodeURIComponent(recording.id)}`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "This video could not be removed.");
      setStudioRecordings((current) => current.filter((item) => item.id !== recording.id));
      setUploadMessage(`“${recording.title}” was removed from the server and viewer library.`);
    } catch (removeError) {
      setRecordingsError(removeError instanceof Error ? removeError.message : "This video could not be removed. Please try again.");
    } finally {
      setDeletingRecordingId("");
    }
  }
  return (
    <main className="stream-studio-page">
      <div className="stream-studio-glow" aria-hidden="true" />
      <div className="stream-studio-shell">
        <header className="stream-studio-header">
          <Brand />
          <nav className="stream-studio-header-actions">
            <Link className="stream-back-link" href={developerMode ? "/developer/churches" : "/zonal/churches"}><FiUsers aria-hidden="true" /> Manage churches</Link>
            {developerMode ? (
              <>
                <SignOutButton developerMode beforeSignOut={session ? leaveActiveBroadcast ?? undefined : undefined} />
                <HistoryBackButton className="stream-back-link" fallbackHref="/developer/developer-space" beforeNavigate={session ? leaveActiveBroadcast ?? undefined : undefined} />
              </>
            ) : (
              <>
                <ZonalPasswordRecovery context="studio" />
                <SignOutButton beforeSignOut={session ? leaveActiveBroadcast ?? undefined : undefined} />
                <HistoryBackButton className="stream-back-link" fallbackHref="/" beforeNavigate={session ? leaveActiveBroadcast ?? undefined : undefined} />
              </>
            )}
          </nav>
        </header>

        {session ? (
          <section className="stream-studio-session">
            <div className="stream-studio-intro stream-studio-intro-compact">
              <span className="stream-studio-kicker"><FiRadio aria-hidden="true" /> NIGERIA SOUTH SOUTH ZONE 1 · BROADCAST STUDIO</span>
              <h1>Your service, <span>live.</span></h1>
              <p>Share the audience link with people you want to invite to this program.</p>
            </div>
            <LiveRoom
              role="host"
              roomName={session.roomName}
              title={session.title}
              participantName={session.participantName}
              shareUrl={session.shareUrl}
              recordingFileHandle={recordingFileHandle}
              recordingAudioContext={recordingAudioContext}
              onRecordingMessage={setRecordingToast}
              onStreamStarted={notifyViewersThatStreamStarted}
              onRegisterHostLeave={registerHostLeave}
              onLeave={handleHostRoomLeave}
            />
          </section>
        ) : studioMode === "choose" ? (
          <section className="stream-studio-choices">
            <div className="stream-studio-intro stream-studio-choices-intro">
              <span className="stream-studio-kicker"><FiRadio aria-hidden="true" /> NIGERIA SOUTH SOUTH ZONE 1 · BROADCAST STUDIO</span>
              <h1>How would you like to share <span>the service?</span></h1>
              <p>Choose a live broadcast or a video recording for the ZoneStream audience.</p>
            </div>
            <div className="stream-studio-mode-grid">
              <button className="stream-studio-mode-card" type="button" onClick={() => setStudioMode("stream")}>
                <span className="stream-studio-mode-icon"><FiRadio aria-hidden="true" /></span>
                <span className="stream-studio-mode-copy">
                  <small>LIVE NOW</small>
                  <strong>Stream a service</strong>
                  <span>Start a live room with the studio camera and microphone. Recording starts automatically on this device.</span>
                </span>
                <FiArrowRight className="stream-studio-mode-arrow" aria-hidden="true" />
              </button>
              <button className="stream-studio-mode-card" type="button" onClick={() => setStudioMode("upload")}>
                <span className="stream-studio-mode-icon"><FiUpload aria-hidden="true" /></span>
                <span className="stream-studio-mode-copy">
                  <small>RECORDED MESSAGE</small>
                  <strong>Upload a video</strong>
                  <span>Save a prepared service video in this browser or the shared Recorded Messages library.</span>
                </span>
                <FiArrowRight className="stream-studio-mode-arrow" aria-hidden="true" />
              </button>
            </div>
            <UploadedVideoLibrary recordings={studioRecordings} loading={recordingsLoading} error={recordingsError} deletingId={deletingRecordingId} onDelete={(recording) => void removeUploadedVideo(recording)} />
          </section>
        ) : studioMode === "upload" ? (
          <section className="stream-studio-upload-page">
            <button className="stream-studio-back-button" type="button" onClick={() => setStudioMode("choose")}>
              <FiArrowLeft aria-hidden="true" /> Back to studio options
            </button>
            <span className="stream-studio-mode-icon"><FiVideo aria-hidden="true" /></span>
            <span className="stream-studio-kicker">RECORDED MESSAGES</span>
            <h1>Add a service <span>video.</span></h1>
            <p>Upload a service video to the shared library. Individuals and churches can watch it from their dashboards.</p>
            {!sharedStorageAvailable ? <p className="stream-studio-upload-pending-note">Shared video uploads are not available right now. You can still record a live service to this device.</p> : null}
            <form className="stream-studio-upload-form" onSubmit={(event) => void uploadPreparedVideo(event)}>
              <label htmlFor="recording-title">Message title</label>
              <input id="recording-title" maxLength={120} placeholder="e.g. Sunday Celebration Service" value={uploadTitle} onChange={(event) => setUploadTitle(event.target.value)} />
              <label htmlFor="recording-video-file">Video file</label>
              <input id="recording-video-file" type="file" accept="video/*" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} />
              {uploadError ? <p className="stream-studio-error" role="alert">{uploadError}</p> : null}
              {uploadMessage ? <p className="stream-studio-upload-success" role="status">{uploadMessage}</p> : null}
              {uploading ? <div className="stream-studio-upload-progress" role="status"><span style={{ width: `${uploadProgress}%` }} /><small>Uploading {uploadProgress}%</small></div> : null}
              <button className="stream-studio-start-button" type="submit" disabled={uploading || !sharedStorageAvailable}>
                <FiUpload aria-hidden="true" /> {uploading ? "Uploading video…" : "Upload to shared library"}
              </button>
            </form>
            <UploadedVideoLibrary recordings={studioRecordings} loading={recordingsLoading} error={recordingsError} deletingId={deletingRecordingId} onDelete={(recording) => void removeUploadedVideo(recording)} />
          </section>
        ) : (
          <div className="stream-studio-layout">
            <section className="stream-studio-intro">
              <span className="stream-studio-kicker"><FiRadio aria-hidden="true" /> NIGERIA SOUTH SOUTH ZONE 1 · BROADCAST STUDIO</span>
              <h1>Bring the service <span>closer.</span></h1>
              <p>Start a live ZoneStream broadcast and share an invite link with your church and viewers.</p>

              <div className="stream-studio-benefits">
                <div className="stream-studio-benefit">
                  <span className="stream-studio-benefit-mark">01</span>
                  <span><strong>Start your live room</strong><small>Use your camera and microphone to go live.</small></span>
                </div>
                <div className="stream-studio-benefit">
                  <span className="stream-studio-benefit-mark">02</span>
                  <span><strong>See who is connected</strong><small>Track individual viewers and connected churches.</small></span>
                </div>
                <div className="stream-studio-benefit">
                  <span className="stream-studio-benefit-mark">03</span>
                  <span><strong>End the room when you’re done</strong><small>Ending the broadcast disconnects everyone in it.</small></span>
                </div>
              </div>
            </section>

            <section className="stream-studio-form-card" aria-labelledby="studio-form-title">
              <div className="stream-studio-form-heading">
                <span className="stream-studio-form-icon"><FiRadio aria-hidden="true" /></span>
                <div>
                  <span className="stream-studio-form-eyebrow">NEW BROADCAST</span>
                  <h2 id="studio-form-title">Set up your service</h2>
                </div>
              </div>

              <form className="stream-studio-form" onSubmit={startBroadcast}>
                <label htmlFor="broadcast-title">Program title</label>
                <input
                  id="broadcast-title"
                  autoComplete="off"
                  maxLength={90}
                  placeholder="e.g. Sunday Celebration Service"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                />

                {error ? <p className="stream-studio-error" role="alert">{error}</p> : null}

                <button className="stream-studio-start-button" type="submit" disabled={starting}>
                  <FiRadio aria-hidden="true" /> {starting ? "Preparing service…" : "Start broadcast"}
                </button>
              </form>

              <p className="stream-studio-recording-note">
                Every live service records automatically to this device. Choose a save location when you start; browsers without a save picker will download the video when recording ends.
              </p>

              <div className="stream-studio-security-note">
                <FiShield aria-hidden="true" />
                  <span>Your Zonal Church sign-in secures the studio. During a live service, you can manage individual access, special guests, and church access.</span>
              </div>
            </section>
          </div>
        )}

        {recordingToast ? <div className="live-room-toast" role="status"><FiHardDrive aria-hidden="true" /><span>{recordingToast}</span></div> : null}

        <footer className="stream-studio-footer">
          <span>ZoneStream · Nigeria South South Zone 1</span>
          <span>Live connection powered by WebRTC</span>
        </footer>
      </div>
    </main>
  );
}
