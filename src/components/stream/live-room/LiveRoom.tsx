"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type LocalVideoTrack,
  type RemoteTrack,
} from "livekit-client";
import { FiCopy, FiMic, FiMicOff, FiPhoneOff, FiVideo, FiVideoOff, FiVolume2 } from "react-icons/fi";
import type { StreamRole } from "../types";
import "./live-room.css";

type LiveRoomProps = {
  role: StreamRole;
  roomName: string;
  title: string;
  participantName: string;
  hostPin?: string;
  shareUrl?: string;
  onLeave: () => void;
};

function AttachedVideo({ track, muted = false }: { track: Track; muted?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    track.attach(videoElement);
    return () => {
      track.detach(videoElement);
    };
  }, [track]);

  return <video ref={videoRef} className="stream-video" autoPlay playsInline muted={muted} />;
}

export default function LiveRoom({
  role,
  roomName,
  title,
  participantName,
  hostPin,
  shareUrl,
  onLeave,
}: LiveRoomProps) {
  const [room, setRoom] = useState<Room | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Connecting);
  const [localVideoTrack, setLocalVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [remoteTracks, setRemoteTracks] = useState<RemoteTrack[]>([]);
  const [viewerCount, setViewerCount] = useState(0);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [audioNeedsGesture, setAudioNeedsGesture] = useState(false);
  const [error, setError] = useState("");
  const [ending, setEnding] = useState(false);
  const audioContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isMounted = true;
    let activeRoom: Room | null = null;

    async function joinRoom() {
      try {
        const response = await fetch("/api/stream/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomName, participantName, role, hostPin }),
        });
        const details = (await response.json()) as { error?: string; serverUrl?: string; participantToken?: string };

        if (!response.ok || !details.serverUrl || !details.participantToken) {
          throw new Error(details.error ?? "Could not prepare the stream connection.");
        }

        const nextRoom = new Room({ adaptiveStream: true, dynacast: true });
        activeRoom = nextRoom;

        nextRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
          if (isMounted) setConnectionState(state);
        });
        nextRoom.on(RoomEvent.Reconnecting, () => {
          if (isMounted) setConnectionState(ConnectionState.Reconnecting);
        });
        nextRoom.on(RoomEvent.Reconnected, () => {
          if (isMounted) setConnectionState(ConnectionState.Connected);
        });
        nextRoom.on(RoomEvent.ParticipantConnected, () => {
          if (isMounted) setViewerCount(nextRoom.remoteParticipants.size);
        });
        nextRoom.on(RoomEvent.ParticipantDisconnected, () => {
          if (isMounted) setViewerCount(nextRoom.remoteParticipants.size);
        });
        nextRoom.on(RoomEvent.TrackSubscribed, (track) => {
          if (isMounted) setRemoteTracks((currentTracks) => [...currentTracks, track]);
        });
        nextRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
          if (isMounted) setRemoteTracks((currentTracks) => currentTracks.filter((item) => item.sid !== track.sid));
        });
        nextRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => {
          if (isMounted) setAudioNeedsGesture(!nextRoom.canPlaybackAudio);
        });
        nextRoom.on(RoomEvent.Disconnected, () => {
          if (isMounted) setConnectionState(ConnectionState.Disconnected);
        });

        await nextRoom.connect(details.serverUrl, details.participantToken);
        if (!isMounted) {
          await nextRoom.disconnect();
          return;
        }

        setRoom(nextRoom);
        setViewerCount(nextRoom.remoteParticipants.size);
        setConnectionState(ConnectionState.Connected);

        if (role === "host") {
          try {
            await nextRoom.localParticipant.enableCameraAndMicrophone();
            const cameraTrack = nextRoom.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
            setLocalVideoTrack(cameraTrack?.kind === Track.Kind.Video ? (cameraTrack as LocalVideoTrack) : null);
            setCameraEnabled(Boolean(cameraTrack));
            setMicrophoneEnabled(Boolean(nextRoom.localParticipant.getTrackPublication(Track.Source.Microphone)?.track));
          } catch {
            setError("The room is ready, but camera or microphone access was blocked. Check browser permissions and use the controls below to try again.");
          }
        }
      } catch (joinError) {
        if (isMounted) {
          setConnectionState(ConnectionState.Disconnected);
          setError(joinError instanceof Error ? joinError.message : "Could not connect to the stream.");
        }
      }
    }

    void joinRoom();

    return () => {
      isMounted = false;
      if (activeRoom) {
        activeRoom.removeAllListeners();
        void activeRoom.disconnect();
      }
    };
  }, [hostPin, participantName, role, roomName]);

  useEffect(() => {
    const audioContainer = audioContainerRef.current;
    if (!audioContainer) return;

    const audioTracks = remoteTracks.filter((track) => track.kind === Track.Kind.Audio);
    const attachedElements = audioTracks.map((track) => {
      const mediaElement = track.attach();
      mediaElement.autoplay = true;
      mediaElement.setAttribute("playsinline", "true");
      audioContainer.appendChild(mediaElement);
      return { track, mediaElement };
    });

    return () => {
      for (const { track, mediaElement } of attachedElements) {
        track.detach(mediaElement);
        mediaElement.remove();
      }
    };
  }, [remoteTracks]);

  const toggleCamera = useCallback(async () => {
    if (!room) return;
    const enabled = !cameraEnabled;
    try {
      await room.localParticipant.setCameraEnabled(enabled);
      const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      setLocalVideoTrack(enabled && track?.kind === Track.Kind.Video ? (track as LocalVideoTrack) : null);
      setCameraEnabled(enabled);
      setError("");
    } catch {
      setError("Could not access the camera. Check your browser permissions and try again.");
    }
  }, [cameraEnabled, room]);

  const toggleMicrophone = useCallback(async () => {
    if (!room) return;
    const enabled = !microphoneEnabled;
    try {
      await room.localParticipant.setMicrophoneEnabled(enabled);
      setMicrophoneEnabled(enabled);
      setError("");
    } catch {
      setError("Could not access the microphone. Check your browser permissions and try again.");
    }
  }, [microphoneEnabled, room]);

  const leaveRoom = useCallback(async () => {
    if (ending) return;
    setEnding(true);
    setError("");

    if (role === "host" && room) {
      try {
        const response = await fetch("/api/stream/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomName, hostPin }),
        });
        const result = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Could not end the broadcast.");
      } catch (leaveError) {
        setError(leaveError instanceof Error ? leaveError.message : "Could not end the broadcast.");
        setEnding(false);
        return;
      }
    }

    await room?.disconnect();
    onLeave();
  }, [ending, hostPin, onLeave, role, room, roomName]);

  const enableAudio = useCallback(async () => {
    try {
      await room?.startAudio();
      setAudioNeedsGesture(false);
    } catch {
      setError("Tap the browser’s audio permission prompt to hear the broadcast.");
    }
  }, [room]);

  const remoteVideoTrack = remoteTracks.find((track) => track.kind === Track.Kind.Video);
  const connected = connectionState === ConnectionState.Connected;
  const connectionLabel =
    connectionState === ConnectionState.Connected
      ? role === "host"
        ? "You’re live"
        : "Connected to the service"
      : connectionState === ConnectionState.Reconnecting
        ? "Reconnecting"
        : connectionState === ConnectionState.Connecting
          ? "Connecting to the stream"
          : "Not connected";

  return (
    <section className={`live-room live-room-${role}`} aria-label={role === "host" ? "Broadcast studio" : "Live broadcast"}>
      <div className="live-room-heading">
        <div>
          <div className={`live-room-status ${connected ? "is-live" : ""}`}>
            <span className="live-room-status-dot" aria-hidden="true" />
            <span>{connectionLabel}</span>
          </div>
          <h2>{title}</h2>
          <p>{role === "host" ? "Your camera and microphone feed the live room." : "Live program from Zonal Church Headquarters."}</p>
        </div>
        <div className="live-room-viewers" aria-live="polite">
          <span className="live-room-viewers-icon" aria-hidden="true">◉</span>
          <span>{role === "host" ? viewerCount : viewerCount + (connected ? 1 : 0)} connected</span>
        </div>
      </div>

      {role === "host" && shareUrl ? (
        <div className="live-room-share">
          <div>
            <span className="live-room-share-label">Audience link</span>
            <span className="live-room-share-url">{shareUrl}</span>
          </div>
          <button
            className="live-room-copy"
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(shareUrl);
                setError("Audience link copied.");
              } catch {
                setError("Copy was blocked by the browser. You can select and copy the link above.");
              }
            }}
          >
            <FiCopy aria-hidden="true" />
            Copy link
          </button>
        </div>
      ) : null}

      <div className="live-room-stage">
        {role === "host" && localVideoTrack ? (
          <AttachedVideo track={localVideoTrack} muted />
        ) : role === "viewer" && remoteVideoTrack ? (
          <AttachedVideo track={remoteVideoTrack} />
        ) : (
          <div className="live-room-placeholder">
            <span className="live-room-placeholder-icon" aria-hidden="true">▶</span>
            <strong>{role === "host" ? "Camera preview will appear here" : connected ? "Waiting for the broadcast" : "Joining the live room"}</strong>
            <span>{role === "host" ? "Allow camera access to begin sharing video." : "Keep this page open while the host connects."}</span>
          </div>
        )}
        <span className="live-room-name-tag">{role === "host" ? participantName : "Zonal Church"}</span>
        <div ref={audioContainerRef} className="live-room-audio" aria-hidden="true" />
      </div>

      {audioNeedsGesture && role === "viewer" ? (
        <button className="live-room-audio-prompt" type="button" onClick={() => void enableAudio()}>
          <FiVolume2 aria-hidden="true" /> Tap to enable broadcast audio
        </button>
      ) : null}

      {error ? <p className={`live-room-message ${error.includes("copied") ? "is-success" : ""}`} role="status">{error}</p> : null}

      {role === "host" ? (
        <div className="live-room-controls" aria-label="Broadcast controls">
          <button className={`live-room-control ${microphoneEnabled ? "" : "is-muted"}`} type="button" onClick={() => void toggleMicrophone()} disabled={!connected}>
            {microphoneEnabled ? <FiMic aria-hidden="true" /> : <FiMicOff aria-hidden="true" />}
            <span>{microphoneEnabled ? "Mute" : "Unmute"}</span>
          </button>
          <button className={`live-room-control ${cameraEnabled ? "" : "is-muted"}`} type="button" onClick={() => void toggleCamera()} disabled={!connected}>
            {cameraEnabled ? <FiVideo aria-hidden="true" /> : <FiVideoOff aria-hidden="true" />}
            <span>{cameraEnabled ? "Stop camera" : "Start camera"}</span>
          </button>
          <button className="live-room-control live-room-end" type="button" onClick={() => void leaveRoom()} disabled={ending}>
            <FiPhoneOff aria-hidden="true" />
            <span>{ending ? "Ending…" : room ? "End broadcast" : "Back to studio"}</span>
          </button>
        </div>
      ) : (
        <div className="live-room-controls live-room-viewer-controls">
          <span className="live-room-listen-note">You’re watching as {participantName}</span>
          <button className="live-room-control live-room-end" type="button" onClick={() => void leaveRoom()} disabled={ending}>
            <FiPhoneOff aria-hidden="true" />
            <span>Leave stream</span>
          </button>
        </div>
      )}
    </section>
  );
}
