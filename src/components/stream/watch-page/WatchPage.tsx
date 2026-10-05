"use client";

import { useEffect, useState, type FormEvent } from "react";
import { FiRadio, FiShield } from "react-icons/fi";
import Brand from "../../brand/Brand";
import HistoryBackButton from "../../history-back-button/HistoryBackButton";
import SignOutButton from "../../sign-out-button/SignOutButton";
import LiveRoom from "../live-room/LiveRoom";
import type { StreamAudienceType } from "../types";
import type { PublicAccountProfile } from "../../../lib/auth/types";
import "./watch-page.css";

export default function WatchPage({ roomName, title, profile, developerPreview = false }: { roomName: string; title: string; profile: PublicAccountProfile | null; developerPreview?: boolean }) {
  const audienceType: StreamAudienceType = developerPreview ? "developer" : profile?.role === "church" ? "church" : "individual";
  const [accessCode, setAccessCode] = useState("");
  const [showSpecialAccess, setShowSpecialAccess] = useState(false);
  const [hasJoined, setHasJoined] = useState(false);
  const [error, setError] = useState("");
  const [accessNotice, setAccessNotice] = useState<"regular-off" | "viewer-paused" | "developer-special" | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("specialAccess") === "1") {
      const timeout = window.setTimeout(() => setShowSpecialAccess(true), 0);
      return () => window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    if (developerPreview) return;
    let active = true;
    fetch("/api/stream/current", { cache: "no-store" })
      .then(async (response) => response.ok
        ? response.json() as Promise<{ program?: { roomName?: string; regularAccessOpen?: boolean; developerSpecialAccess?: boolean; viewerPaused?: boolean } | null }>
        : { program: null })
      .then((result) => {
        if (!active || result.program?.roomName !== roomName || typeof result.program.regularAccessOpen !== "boolean") return;
        setAccessNotice(result.program.viewerPaused
          ? "viewer-paused"
          : result.program.developerSpecialAccess && !result.program.regularAccessOpen
            ? "developer-special"
            : result.program.regularAccessOpen ? null : "regular-off");
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [developerPreview, roomName]);

  function joinBroadcast(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (showSpecialAccess && !/^[A-Za-z0-9]{6}$/.test(accessCode.trim())) {
      setError("Special-access codes are six letters or numbers.");
      return;
    }
    setError("");
    setAccessCode(showSpecialAccess ? accessCode.trim().toUpperCase() : "");
    setHasJoined(true);
  }

  return (
    <main className="stream-watch-page">
      <div className="stream-watch-glow" aria-hidden="true" />
      <div className="stream-watch-shell">
        <header className="stream-watch-header">
          <Brand />
          <nav className="stream-watch-header-actions" aria-label="Account navigation">
            <HistoryBackButton className="stream-back-link" fallbackHref="/dashboard" />
            <SignOutButton developerMode={developerPreview} />
          </nav>
        </header>

        <section className="stream-watch-content">
          <div className="stream-watch-heading">
            <span className="stream-studio-kicker"><FiRadio aria-hidden="true" /> NIGERIA SOUTH SOUTH ZONE 1 · LIVE SERVICE</span>
            <h1>{title}</h1>
            <p>{developerPreview ? "A private owner preview of the current service." : "Join the service from wherever you are."}</p>
          </div>

          {hasJoined ? (
            <LiveRoom
              role="viewer"
              roomName={roomName}
              title={title}
              participantName={developerPreview ? "ZoneStream Developer" : profile?.displayName ?? "Viewer"}
              audienceType={audienceType}
              accessCode={accessCode}
              developerPreview={developerPreview}
              recordingAudioContext={null}
              onRecordingMessage={() => undefined}
              onLeave={() => setHasJoined(false)}
            />
          ) : (
            <div className="stream-watch-join-card">
              <span className="stream-watch-icon"><FiRadio aria-hidden="true" /></span>
              <h2>Come on in</h2>
              <p>{developerPreview ? "This private preview is excluded from church and individual attendance totals." : "Your signed-in account details will be used to identify you in the service."}</p>
              <form className="stream-watch-form" onSubmit={joinBroadcast}>
                <div className="stream-watch-account">
                  <span>{developerPreview ? "Owner preview" : audienceType === "church" ? "Church account" : "Signed in as"}</span>
                  <strong>{developerPreview ? "ZoneStream Developer" : profile?.displayName}</strong>
                </div>

                {!developerPreview && accessNotice ? (
                  <p className="stream-watch-access-paused" role="status">
                    {accessNotice === "viewer-paused"
                      ? "Viewer access is temporarily paused across the platform."
                      : accessNotice === "developer-special"
                        ? "Developer special access is active for your signed-in account. Your regular access is currently off."
                        : audienceType === "church"
                          ? "Regular church access is off for this service. If you were given a special-access code, you can enter it below."
                          : "Regular individual access is off for this service. If you were given a special-access code, you can enter it below."}
                  </p>
                ) : null}

                {!developerPreview ? <button
                  className="stream-watch-special-link"
                  type="button"
                  aria-expanded={showSpecialAccess}
                  onClick={() => {
                    setShowSpecialAccess((shown) => !shown);
                    setError("");
                  }}
                >
                  {showSpecialAccess ? "Hide special-access code entry" : "Enter a special-access code"}
                </button> : null}

                {!developerPreview && showSpecialAccess ? (
                  <>
                    <label htmlFor="special-access-code">Special access code</label>
                    <input
                      id="special-access-code"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="Enter your six-character code"
                      value={accessCode}
                      onChange={(event) => setAccessCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                    />
                    <small className="stream-watch-special-note">A code can be used by one individual or church for this live service. Keep this browser session to reconnect with the same code.</small>
                  </>
                ) : null}

                {error ? <p className="stream-watch-error" role="alert">{error}</p> : null}
                <button className="stream-watch-join-button" type="submit">Join live service</button>
              </form>
              <div className="stream-watch-open-note">
                <FiShield aria-hidden="true" />
                <span>{developerPreview ? "Private developer preview does not appear in Studio attendance totals." : "Regular access follows the Zonal Church’s settings. Special codes can be used by individuals or churches."}</span>
              </div>
            </div>
          )}
        </section>

        <footer className="stream-watch-footer">
          <span>ZoneStream · Nigeria South South Zone 1</span>
          <span>We’re glad you’re here.</span>
        </footer>
      </div>
    </main>
  );
}
