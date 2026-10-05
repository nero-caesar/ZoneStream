"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState, Room, RoomEvent, Track, type LocalVideoTrack } from "livekit-client";
import { FiArrowLeft, FiMic, FiMicOff, FiPhoneOff, FiVideo, FiVideoOff } from "react-icons/fi";
import Link from "next/link";
import ProgramMonitor from "./ProgramMonitor";
import "./remote-presenter.css";

type PresenterLoginChoiceProps = {
  nextPath: string;
  title: string;
};

export function PresenterLoginChoice({ nextPath, title }: PresenterLoginChoiceProps) {
  const query = `?next=${encodeURIComponent(nextPath)}`;
  return (
    <main className="presenter-shell">
      <section className="presenter-card presenter-login-card">
        <Link className="presenter-back" href="/dashboard"><FiArrowLeft aria-hidden="true" /> Back</Link>
        <span className="presenter-eyebrow">ZONE STREAM · REMOTE PRESENTER</span>
        <h1>Sign in to present</h1>
        <p>You’ve been invited to speak during <strong>{title}</strong>. Sign in with your own account to connect your camera and microphone.</p>
        <div className="presenter-login-options">
          <Link href={`/login-page-individual${query}`}>Individual account <span>Sign in or create an account</span></Link>
          <Link href={`/login-page-church${query}`}>Church account <span>Continue with your church ID</span></Link>
        </div>
      </section>
    </main>
  );
}

export default function RemotePresenter({
  roomName,
  title,
  inviteToken,
  presenterName,
}: {
  roomName: string;
  title: string;
  inviteToken: string;
  presenterName: string;
}) {
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [videoTrack, setVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const roomRef = useRef<Room | null>(null);
  const inviteIdRef = useRef("");
  const isConnectedRef = useRef(false);

  const reportConnection = useCallback((connected: boolean) => {
    if (isConnectedRef.current === connected) return;
    isConnectedRef.current = connected;
    window.dispatchEvent(new CustomEvent("zonestream:stream-state", { detail: { active: connected } }));
    void fetch("/api/stream/presenter-activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomName, inviteId: inviteIdRef.current, event: connected ? "connected" : "disconnected" }),
    }).catch(() => undefined);
  }, [roomName]);

  const disconnect = useCallback(async () => {
    const activeRoom = roomRef.current;
    roomRef.current = null;
    setVideoTrack(null);
    setCameraEnabled(false);
    setMicrophoneEnabled(false);
    setConnectionState(ConnectionState.Disconnected);
    reportConnection(false);
    if (activeRoom) {
      activeRoom.removeAllListeners();
      await activeRoom.disconnect();
    }
  }, [reportConnection]);

  const connect = useCallback(async () => {
    if (busy || roomRef.current) return;
    setBusy(true);
    setError("");
    try {
      const tokenResponse = await fetch("/api/stream/presenter-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, inviteToken }),
      });
      const tokenResult = await tokenResponse.json() as { error?: string; serverUrl?: string; participantToken?: string; inviteId?: string };
      if (!tokenResponse.ok || !tokenResult.serverUrl || !tokenResult.participantToken || !tokenResult.inviteId) {
        throw new Error(tokenResult.error ?? "Could not prepare the presenter connection.");
      }

      const activeRoom = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = activeRoom;
      inviteIdRef.current = tokenResult.inviteId;
      activeRoom.on(RoomEvent.ConnectionStateChanged, (state) => setConnectionState(state));
      activeRoom.on(RoomEvent.Disconnected, () => {
        if (roomRef.current === activeRoom) {
          roomRef.current = null;
          setVideoTrack(null);
          setCameraEnabled(false);
          setMicrophoneEnabled(false);
        }
        reportConnection(false);
      });

      await activeRoom.connect(tokenResult.serverUrl, tokenResult.participantToken);
      await activeRoom.localParticipant.enableCameraAndMicrophone();
      const localVideo = activeRoom.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      const localAudio = activeRoom.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      if (!localVideo && !localAudio) throw new Error("Allow camera or microphone access in your browser to present.");
      setVideoTrack(localVideo?.kind === Track.Kind.Video ? localVideo as LocalVideoTrack : null);
      setCameraEnabled(Boolean(localVideo));
      setMicrophoneEnabled(Boolean(localAudio));
      reportConnection(true);
    } catch (connectError) {
      await disconnect();
      setError(connectError instanceof Error ? connectError.message : "Could not connect as presenter.");
    } finally {
      setBusy(false);
    }
  }, [busy, disconnect, inviteToken, reportConnection, roomName]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !videoTrack) return;
    videoTrack.attach(videoElement);
    return () => {
      videoTrack.detach(videoElement);
      videoElement.srcObject = null;
    };
  }, [videoTrack]);

  useEffect(() => {
    return () => {
      const activeRoom = roomRef.current;
      roomRef.current = null;
      if (activeRoom) {
        activeRoom.removeAllListeners();
        void activeRoom.disconnect();
      }
      if (isConnectedRef.current) {
        isConnectedRef.current = false;
        window.dispatchEvent(new CustomEvent("zonestream:stream-state", { detail: { active: false } }));
        void fetch("/api/stream/presenter-activity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomName, inviteId: inviteIdRef.current, event: "disconnected" }),
        }).catch(() => undefined);
      }
    };
  }, [roomName]);

  const toggleCamera = async () => {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    const enabled = !cameraEnabled;
    try {
      await activeRoom.localParticipant.setCameraEnabled(enabled);
      const track = activeRoom.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      setVideoTrack(enabled && track?.kind === Track.Kind.Video ? track as LocalVideoTrack : null);
      setCameraEnabled(enabled);
    } catch {
      setError("Could not change camera access. Check your browser permissions.");
    }
  };

  const toggleMicrophone = async () => {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    const enabled = !microphoneEnabled;
    try {
      await activeRoom.localParticipant.setMicrophoneEnabled(enabled);
      setMicrophoneEnabled(enabled);
    } catch {
      setError("Could not change microphone access. Check your browser permissions.");
    }
  };

  const connected = connectionState === ConnectionState.Connected;
  return (
    <main className="presenter-shell">
      <section className="presenter-card">
        <Link className="presenter-back" href="/dashboard"><FiArrowLeft aria-hidden="true" /> Back to dashboard</Link>
        <div className="presenter-heading">
          <span className="presenter-eyebrow">REMOTE PRESENTER</span>
          <span className={`presenter-status${connected ? " is-live" : ""}`}><span />{connected ? "Connected to live service" : "Ready to connect"}</span>
        </div>
        <h1>{title}</h1>
        <p className="presenter-description">You’re joining as <strong>{presenterName}</strong>. Your camera and microphone go backstage to the Studio. You appear in the public program only when the Studio selects your feed.</p>

        <div className="presenter-preview">
          {videoTrack ? <video ref={videoRef} autoPlay muted playsInline /> : <div className="presenter-preview-placeholder"><FiVideoOff aria-hidden="true" /><span>Camera preview</span></div>}
          <span className="presenter-name-tag">{presenterName}</span>
        </div>

        <ProgramMonitor active={connected} roomName={roomName} inviteToken={inviteToken} />

        {error ? <p className="presenter-error" role="alert">{error}</p> : null}
        <div className="presenter-controls">
          {!connected ? (
            <button className="presenter-connect" type="button" onClick={() => void connect()} disabled={busy}>
              {busy ? "Connecting…" : "Connect to live service"}
            </button>
          ) : (
            <>
              <button className={microphoneEnabled ? "" : "is-off"} type="button" onClick={() => void toggleMicrophone()}>{microphoneEnabled ? <FiMic /> : <FiMicOff />} {microphoneEnabled ? "Mute microphone" : "Unmute microphone"}</button>
              <button className={cameraEnabled ? "" : "is-off"} type="button" onClick={() => void toggleCamera()}>{cameraEnabled ? <FiVideo /> : <FiVideoOff />} {cameraEnabled ? "Stop camera" : "Start camera"}</button>
              <button className="presenter-leave" type="button" onClick={() => void disconnect()}><FiPhoneOff /> Leave service</button>
            </>
          )}
        </div>
        <p className="presenter-audio-note">The monitor contains only the public feed. Use headphones if the Studio puts your own microphone on air.</p>
      </section>
    </main>
  );
}
