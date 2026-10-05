"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { FiArrowRight, FiClock, FiCloud, FiLogOut, FiRadio, FiVideo } from "react-icons/fi";
import Brand from "../brand/Brand";
import IndividualNotifications from "../individual-notifications/IndividualNotifications";
import type { PublicAccountProfile } from "../../lib/auth/types";
import { getFirebaseClient } from "../../lib/firebase/client";
import "./account-dashboard.css";

type CurrentProgram = { title: string; shareUrl: string; startedAt: string; audienceOpen: boolean; regularAccessOpen?: boolean; developerSpecialAccess?: boolean; viewerPaused?: boolean; specialAccess: boolean; specialCodeAvailable: boolean };
type SharedRecording = { id: string; title: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: number; downloadUrl: string };
type DashboardRecording = SharedRecording & { src: string };

export default function AccountDashboard({ profile }: { profile: PublicAccountProfile }) {
  const router = useRouter();
  const [program, setProgram] = useState<CurrentProgram | null>(null);
  const [loading, setLoading] = useState(true);
  const [recordings, setRecordings] = useState<DashboardRecording[]>([]);
  const [recordingsLoading, setRecordingsLoading] = useState(true);
  const [recordingsError, setRecordingsError] = useState("");
  const [recordingsReload, setRecordingsReload] = useState(0);
  const isChurch = profile.role === "church";

  const handleViewerNotification = useCallback((notification: { kind: "live_started" | "recording_uploaded" }) => {
    if (notification.kind === "live_started") {
      void fetch("/api/stream/current", { cache: "no-store" })
        .then(async (response) => response.ok ? response.json() as Promise<{ program?: CurrentProgram | null }> : { program: null })
        .then((result) => setProgram(result.program ?? null))
        .catch(() => undefined);
    } else {
      setRecordingsError("");
      setRecordingsLoading(true);
      setRecordingsReload((current) => current + 1);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/stream/current")
      .then(async (response) => response.ok ? response.json() as Promise<{ program?: CurrentProgram | null }> : { program: null })
      .then((result) => { if (active) setProgram(result.program ?? null); })
      .catch(() => { if (active) setProgram(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/recordings", { cache: "no-store" })
      .then(async (response) => response.ok
        ? response.json() as Promise<{ recordings?: SharedRecording[] }>
        : { recordings: [] })
      .then((result) => {
        if (!active) return;
        const sharedItems: DashboardRecording[] = (result.recordings ?? []).map((recording) => ({
          ...recording,
          src: recording.downloadUrl,
        }));
        setRecordings(sharedItems.sort((first, second) => second.createdAt - first.createdAt));
        setRecordingsLoading(false);
      })
      .catch(() => {
        if (active) {
          setRecordingsError("Recorded messages could not be loaded. Please refresh and try again.");
          setRecordingsLoading(false);
        }
      });

    return () => { active = false; };
  }, [recordingsReload]);

  async function logout() {
    await fetch("/api/auth/session", { method: "DELETE" });
    try {
      const { auth } = getFirebaseClient();
      await signOut(auth);
    } catch {
      // The server session has already been cleared.
    }
    router.replace("/");
  }

  return (
    <main className="member-dashboard">
      <div className="member-dashboard-shell">
        <header className="member-dashboard-header">
          <Brand />
          <button className="member-dashboard-logout" type="button" onClick={() => void logout()}><FiLogOut aria-hidden="true" /> Sign out</button>
        </header>

        <section className="member-dashboard-welcome">
          <span className="member-dashboard-eyebrow">{isChurch ? "CHURCH PORTAL" : "INDIVIDUAL PORTAL"} · NIGERIA SOUTH SOUTH ZONE 1</span>
          <h1>Welcome, <span>{isChurch ? profile.displayName : profile.displayName.split(" ")[0]}.</span></h1>
          <p>{isChurch ? "Your church account is ready to connect to Zonal services." : "Your ZoneStream services and recordings will be gathered here."}</p>
        </section>

        {!isChurch ? <IndividualNotifications onNotification={handleViewerNotification} /> : null}

        <section className="member-dashboard-grid" aria-label="ZoneStream content">
          <article className="member-dashboard-card member-dashboard-live">
            <div className="member-dashboard-card-heading">
              <span className="member-dashboard-icon"><FiRadio aria-hidden="true" /></span>
              <span><small>LIVE SERVICE</small><h2>Current streaming service</h2></span>
            </div>
            {loading ? <p className="member-dashboard-empty">Checking for a live service…</p> : program ? (
              <div className="member-dashboard-program">
                <span className="member-dashboard-live-pill"><span /> LIVE NOW</span>
                <h3>{program.title}</h3>
                {program.startedAt ? <p><FiClock aria-hidden="true" /> Started {new Date(program.startedAt).toLocaleString()}</p> : null}
                <span className={`member-dashboard-access-status ${(program.regularAccessOpen ?? program.audienceOpen) || program.developerSpecialAccess ? "is-open" : "is-restricted"}`}>
                  {(program.regularAccessOpen ?? program.audienceOpen)
                    ? "Your regular access is on"
                    : program.viewerPaused
                      ? "Viewer access is paused"
                      : program.developerSpecialAccess
                        ? "Developer special access is active"
                        : isChurch ? "Church access is off" : "Regular individual access is off"}
                </span>
                <a className="member-dashboard-primary" href={program.shareUrl}>Join live service <FiArrowRight aria-hidden="true" /></a>
              </div>
            ) : <p className="member-dashboard-empty">There isn’t a live service at the moment. This card will update when the Zonal Church starts one.</p>}
          </article>

          <article className="member-dashboard-card member-dashboard-recordings" id="recorded-messages">
            <div className="member-dashboard-card-heading">
              <span className="member-dashboard-icon"><FiVideo aria-hidden="true" /></span>
              <span><small>WATCH AGAIN</small><h2>Recorded messages</h2></span>
            </div>
            {recordingsLoading ? <p className="member-dashboard-empty">Loading recorded messages…</p> : recordings.length ? (
              <div className="member-dashboard-recording-list">
                {recordings.map((recording) => (
                  <article className="member-dashboard-recording" key={recording.id}>
                    <div className="member-dashboard-recording-heading">
                      <div><h3>{recording.title}</h3><p><FiClock aria-hidden="true" /> {recording.createdAt ? new Date(recording.createdAt).toLocaleDateString() : "Date unavailable"}</p></div>
                      <span className="member-dashboard-recording-source"><FiCloud aria-hidden="true" /> Shared library</span>
                    </div>
                    <video controls preload="none" src={recording.src} aria-label={`Play ${recording.title}`} />
                    <small>{recording.fileName}{recording.sizeBytes ? ` · ${(recording.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : ""}</small>
                  </article>
                ))}
              </div>
            ) : (
              <>
                <p className="member-dashboard-empty">Shared recordings published by the Zonal Church will appear here.</p>
                <span className="member-dashboard-coming-soon">{recordingsError || "No recordings available yet"}</span>
              </>
            )}
          </article>
        </section>

        <footer className="member-dashboard-footer"><span>Signed in as {profile.displayName}</span>{isChurch ? <span>Church access is managed by the Zonal Church.</span> : null}</footer>
      </div>
    </main>
  );
}
