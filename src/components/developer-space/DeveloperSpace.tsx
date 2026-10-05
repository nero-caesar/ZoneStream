"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FiAlertTriangle, FiArrowLeft, FiCheck, FiExternalLink, FiLock, FiLogOut, FiRadio, FiShield, FiUnlock, FiUsers, FiVideo } from "react-icons/fi";
import Brand from "../brand/Brand";
import HistoryBackButton from "../history-back-button/HistoryBackButton";
import DeveloperSpecialAccess from "./DeveloperSpecialAccess";
import "./developer-space.css";

type PageMode = "setup" | "login" | "dashboard" | "unavailable";
type OwnerActivity = { id: string; action: string; label?: string; at: string };
type OwnerRecording = { id: string; title: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: number; downloadUrl: string };
type DashboardData = {
  program: { roomName: string; title: string; startedAt: string } | null;
  viewerPaused: boolean;
  activity: OwnerActivity[];
  recordings?: OwnerRecording[];
  recordingsAvailable?: boolean;
};

export default function DeveloperSpace({ initialMode }: { initialMode: PageMode }) {
  const [mode, setMode] = useState(initialMode);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadDashboard = useCallback(async () => {
    try {
      const response = await fetch("/api/developer/overview", { cache: "no-store" });
      if (response.status === 401) {
        setMode("login");
        return;
      }
      const result = await response.json() as DashboardData & { error?: string };
      if (!response.ok) throw new Error(result.error || "The owner dashboard could not load.");
      const recordingsResponse = await fetch("/api/recordings", { cache: "no-store" }).catch(() => null);
      const recordingsResult = recordingsResponse?.ok
        ? await recordingsResponse.json() as { recordings?: OwnerRecording[]; sharedStorageAvailable?: boolean }
        : null;
      setDashboard({
        ...result,
        recordings: recordingsResult?.recordings ?? [],
        recordingsAvailable: recordingsResult?.sharedStorageAvailable === true,
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The owner dashboard could not load.");
    }
  }, []);

  useEffect(() => {
    if (mode !== "dashboard") return;
    const initialLoad = window.setTimeout(() => void loadDashboard(), 0);
    const interval = window.setInterval(() => void loadDashboard(), 15000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadDashboard, mode]);

  async function submitAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");

    if (mode === "setup" && password !== confirmPassword) {
      setError("Those passwords do not match.");
      setBusy(false);
      return;
    }

    try {
      const endpoint = mode === "setup" ? "/api/developer/setup" : "/api/developer/session";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Developer access could not be verified.");
      setPassword("");
      setConfirmPassword("");
      setMode("dashboard");
      setNotice(mode === "setup" ? "Developer Space is ready. Keep your passphrase private." : "Signed in to Developer Space.");
      window.dispatchEvent(new Event("zonestream:session-started"));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Developer access could not be verified.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/developer/session", { method: "DELETE" }).catch(() => undefined);
    window.dispatchEvent(new Event("zonestream:session-ended"));
    setDashboard(null);
    setMode("login");
    setNotice("You have signed out of Developer Space.");
  }

  async function toggleViewerPause() {
    if (!dashboard) return;
    const nextPaused = !dashboard.viewerPaused;
    const message = nextPaused
      ? "Pause viewer access? Everyone watching will be disconnected, and new viewer joins will be blocked. The broadcast itself stays live."
      : "Resume viewer access? Viewers can rejoin if the studio's attendance rules allow them.";
    if (!window.confirm(message)) return;

    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/developer/overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewerPaused: nextPaused }),
      });
      const result = await response.json() as { error?: string; warning?: string; disconnectedCount?: number };
      if (!response.ok) throw new Error(result.error || "The platform access setting could not be saved.");
      setNotice(result.warning || (nextPaused
        ? `Viewer access is paused. ${result.disconnectedCount ?? 0} current viewers were disconnected.`
        : "Viewer access has resumed. Studio attendance rules still apply."));
      await loadDashboard();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The platform access setting could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function retryViewerDisconnect() {
    if (!dashboard?.viewerPaused) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/developer/overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewerPaused: true }),
      });
      const result = await response.json() as { error?: string; warning?: string; disconnectedCount?: number };
      if (!response.ok) throw new Error(result.error || "Connected viewers could not be disconnected.");
      setNotice(result.warning || `${result.disconnectedCount ?? 0} viewer${result.disconnectedCount === 1 ? " was" : "s were"} disconnected. Viewer access remains paused.`);
      await loadDashboard();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Connected viewers could not be disconnected.");
    } finally {
      setBusy(false);
    }
  }

  const previewUrl = dashboard?.program
    ? `/stream/watch/${encodeURIComponent(dashboard.program.roomName)}?developerPreview=1&title=${encodeURIComponent(dashboard.program.title)}`
    : "";

  function describeOwnerAction(action: string) {
    return action === "zonal_password_reset_email_sent" ? "Sent a Zonal Studio password reset link" : "Updated a platform setting";
  }

  return (
    <main className="developer-page">
      <div className="developer-glow developer-glow-blue" aria-hidden="true" />
      <div className="developer-glow developer-glow-coral" aria-hidden="true" />
      <div className="developer-shell">
        <header className="developer-header">
          <Brand />
          {mode === "dashboard"
            ? <HistoryBackButton className="developer-back-link" fallbackHref="/" />
            : <Link className="developer-back-link" href="/"><FiArrowLeft aria-hidden="true" /> Back home</Link>}
        </header>

        {mode === "dashboard" && dashboard ? (
          <section className="developer-dashboard" aria-labelledby="developer-title">
            <div className="developer-title-row">
              <div>
                <span className="developer-kicker"><FiShield aria-hidden="true" /> OWNER ACCESS</span>
                <h1 id="developer-title">Developer Space</h1>
                <p>Private platform controls for ZoneStream.</p>
              </div>
              <button className="developer-signout" type="button" onClick={() => void signOut()}><FiLogOut aria-hidden="true" /> Sign out</button>
            </div>

            {error ? <p className="developer-notice is-error" role="alert">{error}</p> : null}
            {notice ? <p className="developer-notice" role="status"><FiCheck aria-hidden="true" /> {notice}</p> : null}

            <div className="developer-card-grid">
              <section className="developer-card developer-live-card" aria-labelledby="developer-live-title">
                <div className="developer-card-heading"><span className="developer-card-icon"><FiRadio aria-hidden="true" /></span><span className="developer-card-eyebrow">LIVE SERVICE</span></div>
                <h2 id="developer-live-title">{dashboard.program ? dashboard.program.title : "No active service"}</h2>
                <p>{dashboard.program ? "Open a private preview. It will not appear in the studio's church or individual counts." : "A preview becomes available when the Zonal Church starts a service."}</p>
                {previewUrl ? <Link className="developer-primary-action" href={previewUrl}><FiExternalLink aria-hidden="true" /> Open private preview</Link> : <span className="developer-disabled-action"><FiRadio aria-hidden="true" /> Waiting for a broadcast</span>}
                <div className="developer-studio-links"><Link href="/developer/studio"><FiRadio aria-hidden="true" /> Open full studio controls</Link><Link href="/developer/churches"><FiUsers aria-hidden="true" /> Manage churches</Link></div>
              </section>

              <section className={`developer-card developer-pause-card${dashboard.viewerPaused ? " is-paused" : ""}`} aria-labelledby="developer-pause-title">
                <div className="developer-card-heading"><span className="developer-card-icon"><FiAlertTriangle aria-hidden="true" /></span><span className="developer-card-eyebrow">PLATFORM OVERRIDE</span></div>
                <h2 id="developer-pause-title">Viewer access {dashboard.viewerPaused ? "paused" : "open"}</h2>
                <p>{dashboard.viewerPaused ? "New viewers are blocked. Current viewer connections have been disconnected; the live broadcast remains active." : "Emergency pause disconnects viewers and blocks new joins. Studio rules remain unchanged when access resumes."}</p>
                <button className={`developer-pause-action${dashboard.viewerPaused ? " is-resume" : ""}`} type="button" onClick={() => void toggleViewerPause()} disabled={busy}>
                  {dashboard.viewerPaused ? <FiUnlock aria-hidden="true" /> : <FiLock aria-hidden="true" />}
                  {busy ? "Saving…" : dashboard.viewerPaused ? "Resume viewer access" : "Pause all viewer access"}
                </button>
                {dashboard.viewerPaused && dashboard.program ? <button className="developer-retry-disconnect" type="button" onClick={() => void retryViewerDisconnect()} disabled={busy}>{busy ? "Checking connections…" : "Retry disconnecting current viewers"}</button> : null}
              </section>
            </div>

            <DeveloperSpecialAccess />

            <section className="developer-recordings" aria-labelledby="developer-recordings-title">
              <div className="developer-requests-heading">
                <div><span className="developer-card-eyebrow">SHARED LIBRARY</span><h2 id="developer-recordings-title"><FiVideo aria-hidden="true" /> Recorded messages</h2></div>
                <span className="developer-request-count">{dashboard.recordings?.length ?? 0} available</span>
              </div>
              {dashboard.recordings?.length ? (
                <div className="developer-recording-list">
                  {dashboard.recordings.map((recording) => (
                    <article className="developer-recording" key={recording.id}>
                      <video controls preload="none" src={recording.downloadUrl} aria-label={`Play ${recording.title}`} />
                      <div><strong>{recording.title}</strong><small>{recording.createdAt ? new Date(recording.createdAt).toLocaleDateString() : "Date unavailable"} · {recording.fileName}</small></div>
                    </article>
                  ))}
                </div>
              ) : <p className="developer-requests-description">{dashboard.recordingsAvailable ? "No shared recordings have been published yet." : "Shared recordings are not available right now."}</p>}
            </section>

            <section className="developer-requests developer-activity" aria-labelledby="developer-activity-title">
              <div className="developer-requests-heading"><div><span className="developer-card-eyebrow">PLATFORM LOG</span><h2 id="developer-activity-title">Platform activity</h2></div></div>
              {dashboard.activity.length ? (
                <ul className="developer-activity-list">{dashboard.activity.map((item) => <li key={item.id}><span>{item.label || describeOwnerAction(item.action)}</span><time>{item.at ? new Date(item.at).toLocaleString() : "recently"}</time></li>)}</ul>
              ) : <p className="developer-requests-description">Church registrations, access changes, live services, and other major platform activity will appear here.</p>}
            </section>
          </section>
        ) : (
          <section className="developer-auth-card" aria-labelledby="developer-title">
            <span className="developer-auth-icon"><FiShield aria-hidden="true" /></span>
            <span className="developer-kicker">PRIVATE OWNER ACCESS</span>
            <h1 id="developer-title">{mode === "setup" ? "Set up Developer Space" : mode === "unavailable" ? "Developer Space unavailable" : "Welcome back"}</h1>
            <p className="developer-auth-description">
              {mode === "setup"
                ? "Create a new private passphrase once from localhost. Use at least 16 characters; the short password shared earlier will not be reused."
                : mode === "unavailable"
                  ? "Developer Space could not load right now. Please try again later."
                  : "Enter the owner passphrase to continue to private platform controls."}
            </p>

            {mode !== "unavailable" ? (
              <form className="developer-auth-form" onSubmit={submitAccess}>
                <label htmlFor="developer-password">{mode === "setup" ? "Create passphrase" : "Password"}</label>
                <input id="developer-password" type="password" autoComplete={mode === "setup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === "setup" ? 16 : undefined} maxLength={128} />
                {mode === "setup" ? <><label htmlFor="developer-password-confirm">Confirm passphrase</label><input id="developer-password-confirm" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={16} maxLength={128} /></> : null}
                {error ? <p className="developer-form-error" role="alert">{error}</p> : null}
                {notice ? <p className="developer-form-notice" role="status">{notice}</p> : null}
                <button className="developer-primary-action developer-auth-submit" type="submit" disabled={busy}>{busy ? "Checking…" : mode === "setup" ? "Create owner password" : "Unlock Developer Space"}</button>
              </form>
            ) : null}
            {mode === "setup" ? <p className="developer-setup-note"><FiLock aria-hidden="true" /> First setup is restricted to this computer. Only a protected password check is saved.</p> : null}
            <Link className="developer-auth-back" href="/"><FiArrowLeft aria-hidden="true" /> Return to the homepage</Link>
          </section>
        )}

        <footer className="developer-footer"><span>ZoneStream · Private owner area</span><span>Activity is recorded for account security.</span></footer>
      </div>
    </main>
  );
}
