"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { FiArrowLeft, FiRadio, FiShield } from "react-icons/fi";
import Brand from "../../brand/Brand";
import LiveRoom from "../live-room/LiveRoom";
import "./watch-page.css";

export default function WatchPage({ roomName, title }: { roomName: string; title: string }) {
  const [participantName, setParticipantName] = useState("");
  const [hasJoined, setHasJoined] = useState(false);
  const [error, setError] = useState("");

  function joinBroadcast(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = participantName.trim();
    if (!cleanName || cleanName.length > 60) {
      setError("Enter a name between 1 and 60 characters.");
      return;
    }
    setError("");
    setParticipantName(cleanName);
    setHasJoined(true);
  }

  return (
    <main className="stream-watch-page">
      <div className="stream-watch-glow" aria-hidden="true" />
      <div className="stream-watch-shell">
        <header className="stream-watch-header">
          <Brand />
          <Link className="stream-back-link" href="/">
            <FiArrowLeft aria-hidden="true" /> Back to ZoneStream
          </Link>
        </header>

        <section className="stream-watch-content">
          <div className="stream-watch-heading">
            <span className="stream-studio-kicker"><FiRadio aria-hidden="true" /> CE BAYELSA · LIVE SERVICE</span>
            <h1>{title}</h1>
            <p>Join the service from wherever you are.</p>
          </div>

          {hasJoined ? (
            <LiveRoom
              role="viewer"
              roomName={roomName}
              title={title}
              participantName={participantName}
              onLeave={() => setHasJoined(false)}
            />
          ) : (
            <div className="stream-watch-join-card">
              <span className="stream-watch-icon"><FiRadio aria-hidden="true" /></span>
              <h2>Come on in</h2>
              <p>Enter your name to join the live broadcast.</p>
              <form className="stream-watch-form" onSubmit={joinBroadcast}>
                <label htmlFor="viewer-name">Your name</label>
                <input
                  id="viewer-name"
                  autoComplete="name"
                  maxLength={60}
                  placeholder="e.g. Ada James"
                  value={participantName}
                  onChange={(event) => setParticipantName(event.target.value)}
                  required
                />
                {error ? <p className="stream-watch-error" role="alert">{error}</p> : null}
                <button className="stream-watch-join-button" type="submit">Join live service</button>
              </form>
              <div className="stream-watch-open-note">
                <FiShield aria-hidden="true" />
                <span>This pilot is link-based. Church and individual attendance rules will be connected when accounts are added.</span>
              </div>
            </div>
          )}
        </section>

        <footer className="stream-watch-footer">
          <span>ZoneStream · CE Bayelsa</span>
          <span>We’re glad you’re here.</span>
        </footer>
      </div>
    </main>
  );
}
