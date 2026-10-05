"use client";

import { useEffect, useRef, useState } from "react";
import { ConnectionState, Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";
import Image from "next/image";

type MonitorSource = { mode: string; flierKey: string; flierFileName: string };

export default function ProgramMonitor({ active, roomName, inviteToken }: { active: boolean; roomName: string; inviteToken: string }) {
  const [state, setState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [videoTrack, setVideoTrack] = useState<RemoteTrack | null>(null);
  const [audioTracks, setAudioTracks] = useState<RemoteTrack[]>([]);
  const [error, setError] = useState("");
  const [audioNeedsGesture, setAudioNeedsGesture] = useState(false);
  const [source, setSource] = useState<MonitorSource>({ mode: "auto", flierKey: "", flierFileName: "" });
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioContainerRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);

  useEffect(() => {
    if (!active) return;

    let mounted = true;
    let activeRoom: Room | null = null;
    let sourceInterval = 0;

    const refreshSource = async () => {
      try {
        const response = await fetch(`/api/stream/source?roomName=${encodeURIComponent(roomName)}`, { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as { source?: { mode?: unknown; flierKey?: unknown; flierFileName?: unknown } };
        if (!mounted || !result.source) return;
        setSource({
          mode: typeof result.source.mode === "string" ? result.source.mode : "auto",
          flierKey: typeof result.source.flierKey === "string" ? result.source.flierKey : "",
          flierFileName: typeof result.source.flierFileName === "string" ? result.source.flierFileName : "",
        });
      } catch {
        // The existing program image remains visible if a source refresh is interrupted.
      }
    };

    async function connectMonitor() {
      setError("");
      setState(ConnectionState.Connecting);
      try {
        const response = await fetch("/api/stream/monitor-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomName, role: "presenter", inviteToken }),
        });
        const result = await response.json() as { error?: string; serverUrl?: string; participantToken?: string };
        if (!response.ok || !result.serverUrl || !result.participantToken) {
          throw new Error(result.error ?? "The program monitor could not connect.");
        }

        const monitorRoom = new Room({ adaptiveStream: true, dynacast: true });
        activeRoom = monitorRoom;
        roomRef.current = monitorRoom;
        monitorRoom.on(RoomEvent.ConnectionStateChanged, (nextState) => {
          if (mounted) setState(nextState);
        });
        monitorRoom.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
          if (!mounted) return;
          try {
            const metadata = JSON.parse(participant.metadata ?? "{}") as { role?: unknown };
            if (metadata.role !== "monitor-publisher") return;
            if (track.kind === Track.Kind.Video) setVideoTrack(track);
            if (track.kind === Track.Kind.Audio) setAudioTracks((current) => [...current.filter((item) => item.sid !== track.sid), track]);
          } catch {
            // Ignore tracks from participants that are not the Studio monitor publisher.
          }
        });
        monitorRoom.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
          try {
            const metadata = JSON.parse(participant.metadata ?? "{}") as { role?: unknown };
            if (metadata.role !== "monitor-publisher") return;
            if (track.kind === Track.Kind.Video) setVideoTrack((current) => current?.sid === track.sid ? null : current);
            if (track.kind === Track.Kind.Audio) setAudioTracks((current) => current.filter((item) => item.sid !== track.sid));
          } catch {
            // Ignore tracks from participants that are not the Studio monitor publisher.
          }
        });
        monitorRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => {
          if (mounted) setAudioNeedsGesture(!monitorRoom.canPlaybackAudio);
        });
        monitorRoom.on(RoomEvent.Disconnected, () => {
          if (mounted) {
            setState(ConnectionState.Disconnected);
            setVideoTrack(null);
            setAudioTracks([]);
          }
        });

        await monitorRoom.connect(result.serverUrl, result.participantToken);
        if (!mounted) {
          await monitorRoom.disconnect();
          return;
        }
        setState(ConnectionState.Connected);
        setAudioNeedsGesture(!monitorRoom.canPlaybackAudio);
        await refreshSource();
        sourceInterval = window.setInterval(() => void refreshSource(), 1800);
      } catch (monitorError) {
        if (mounted) {
          setState(ConnectionState.Disconnected);
          setError(monitorError instanceof Error ? monitorError.message : "The program monitor could not connect.");
        }
      }
    }

    void connectMonitor();
    return () => {
      mounted = false;
      window.clearInterval(sourceInterval);
      if (roomRef.current === activeRoom) roomRef.current = null;
      activeRoom?.removeAllListeners();
      if (activeRoom) void activeRoom.disconnect();
    };
  }, [active, inviteToken, roomName]);

  useEffect(() => {
    const element = videoRef.current;
    if (!active || !element || !videoTrack) return;
    videoTrack.attach(element);
    return () => {
      videoTrack.detach(element);
      element.srcObject = null;
    };
  }, [active, videoTrack]);

  useEffect(() => {
    const container = audioContainerRef.current;
    if (!active || !container) return;
    const attached = audioTracks.map((track) => {
      const element = track.attach();
      element.autoplay = true;
      element.setAttribute("playsinline", "true");
      container.appendChild(element);
      return { track, element };
    });
    return () => {
      attached.forEach(({ track, element }) => {
        track.detach(element);
        element.remove();
      });
    };
  }, [active, audioTracks]);

  async function enableAudio() {
    try {
      await roomRef.current?.startAudio();
      setAudioNeedsGesture(false);
      setError("");
    } catch {
      setError("Tap the browser’s audio control to allow monitor sound.");
    }
  }

  const connected = active && state === ConnectionState.Connected;
  const displayState = active ? state : ConnectionState.Disconnected;
  const showFlier = active && (source.mode === "flier" || source.mode === "flier-audio");
  const flierUrl = source.flierKey ? `/api/stream/flier?roomName=${encodeURIComponent(roomName)}&key=${encodeURIComponent(source.flierKey)}` : "";
  return (
    <section className="presenter-program-monitor" aria-labelledby="program-monitor-title">
      <div className="presenter-monitor-heading">
        <div>
          <span className="presenter-eyebrow">PRIVATE PROGRAM MONITOR</span>
          <h2 id="program-monitor-title">What viewers are seeing</h2>
        </div>
        <span className={`presenter-monitor-state${connected ? " is-connected" : ""}`}>{connected ? "Connected" : displayState === ConnectionState.Connecting ? "Connecting…" : "Waiting"}</span>
      </div>
      <div className="presenter-monitor-screen">
        {showFlier && flierUrl ? <Image src={flierUrl} alt={source.flierFileName || "Service flier on air"} width={1280} height={720} unoptimized /> : showFlier ? <div className="presenter-monitor-placeholder">Loading the service flier</div> : videoTrack ? <video ref={videoRef} autoPlay playsInline /> : <div className="presenter-monitor-placeholder">{connected ? "Waiting for Studio to put a feed on air" : "Connecting to the program monitor"}</div>}
        <div ref={audioContainerRef} className="presenter-monitor-audio" aria-hidden="true" />
      </div>
      {active && audioNeedsGesture ? <button className="presenter-monitor-audio-button" type="button" onClick={() => void enableAudio()}>Enable monitor audio</button> : null}
      {error ? <p className="presenter-error" role="status">{error}</p> : null}
    </section>
  );
}
