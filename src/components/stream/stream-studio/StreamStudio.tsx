"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { FiArrowLeft, FiRadio, FiShield } from "react-icons/fi";
import Brand from "../../brand/Brand";
import LiveRoom from "../live-room/LiveRoom";
import type { StreamSession } from "../types";
import "./stream-studio.css";

export default function StreamStudio() {
  const [session, setSession] = useState<StreamSession | null>(null);
  const [title, setTitle] = useState("");
  const [participantName, setParticipantName] = useState("Zonal Church");
  const [hostPin, setHostPin] = useState("");
  const [error, setError] = useState("");

  function startBroadcast(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const cleanTitle = title.trim();
    const cleanName = participantName.trim();
    if (!cleanTitle || !cleanName || !hostPin) {
      setError("Add a program title, host name, and studio access code to continue.");
      return;
    }

    const roomName = `zonestream-${window.crypto.randomUUID().slice(0, 12)}`;
    const shareUrl = `${window.location.origin}/stream/watch/${roomName}?title=${encodeURIComponent(cleanTitle)}`;
    setSession({ roomName, title: cleanTitle, participantName: cleanName, shareUrl, hostPin });
  }

  return (
    <main className="stream-studio-page">
      <div className="stream-studio-glow" aria-hidden="true" />
      <div className="stream-studio-shell">
        <header className="stream-studio-header">
          <Brand />
          <Link className="stream-back-link" href="/">
            <FiArrowLeft aria-hidden="true" /> Back to ZoneStream
          </Link>
        </header>

        {session ? (
          <section className="stream-studio-session">
            <div className="stream-studio-intro stream-studio-intro-compact">
              <span className="stream-studio-kicker"><FiRadio aria-hidden="true" /> ZONAL CHURCH · BROADCAST STUDIO</span>
              <h1>Your service, <span>live.</span></h1>
              <p>Share the audience link with people you want to invite to this program.</p>
            </div>
            <LiveRoom
              role="host"
              roomName={session.roomName}
              title={session.title}
              participantName={session.participantName}
              hostPin={session.hostPin}
              shareUrl={session.shareUrl}
              onLeave={() => setSession(null)}
            />
          </section>
        ) : (
          <div className="stream-studio-layout">
            <section className="stream-studio-intro">
              <span className="stream-studio-kicker"><FiRadio aria-hidden="true" /> ZONAL CHURCH · BROADCAST STUDIO</span>
              <h1>Bring the service <span>closer.</span></h1>
              <p>Start a live ZoneStream broadcast and share an invite link with your church and viewers.</p>

              <div className="stream-studio-benefits">
                <div className="stream-studio-benefit">
                  <span className="stream-studio-benefit-mark">01</span>
                  <span><strong>Start your live room</strong><small>Use your camera and microphone to go live.</small></span>
                </div>
                <div className="stream-studio-benefit">
                  <span className="stream-studio-benefit-mark">02</span>
                  <span><strong>Share one audience link</strong><small>Viewers can join from a phone or computer.</small></span>
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

                <label htmlFor="host-name">Host name</label>
                <input
                  id="host-name"
                  autoComplete="name"
                  maxLength={60}
                  value={participantName}
                  onChange={(event) => setParticipantName(event.target.value)}
                  required
                />

                <label htmlFor="studio-code">Studio access code</label>
                <input
                  id="studio-code"
                  autoComplete="current-password"
                  type="password"
                  placeholder="Enter the code configured for this pilot"
                  value={hostPin}
                  onChange={(event) => setHostPin(event.target.value)}
                  required
                />

                {error ? <p className="stream-studio-error" role="alert">{error}</p> : null}

                <button className="stream-studio-start-button" type="submit">
                  <FiRadio aria-hidden="true" /> Start broadcast
                </button>
              </form>

              <div className="stream-studio-security-note">
                <FiShield aria-hidden="true" />
                <span>This pilot uses a studio code. Church and individual access rules will be added with accounts.</span>
              </div>
            </section>
          </div>
        )}

        <footer className="stream-studio-footer">
          <span>ZoneStream · CE Bayelsa</span>
          <span>Live connection powered by WebRTC</span>
        </footer>
      </div>
    </main>
  );
}
