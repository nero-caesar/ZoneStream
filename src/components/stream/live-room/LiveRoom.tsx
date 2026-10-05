"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type LocalVideoTrack,
  type RemoteTrack,
} from "livekit-client";
import { FiAlertTriangle, FiCheck, FiCopy, FiHardDrive, FiKey, FiMic, FiMicOff, FiPhoneOff, FiSquare, FiUsers, FiVideo, FiVideoOff, FiVolume2 } from "react-icons/fi";
import { FaChurch } from "react-icons/fa";
import {
  DEFAULT_STREAM_ACCESS_POLICY,
  isPlatformViewerPaused,
  parsePublicStreamAccessPolicy,
  type PublicSpecialAccessCode,
} from "../../../lib/stream/access-policy";
import type { StreamAudienceType, StreamRole } from "../types";
import { createLocalDeviceRecorder, type LocalRecordingFileHandle } from "../../../lib/stream/local-recording";
import "./live-room.css";

type LiveRoomProps = {
  role: StreamRole;
  roomName: string;
  title: string;
  participantName: string;
  audienceType?: StreamAudienceType;
  accessCode?: string;
  developerPreview?: boolean;
  shareUrl?: string;
  recordingFileHandle?: LocalRecordingFileHandle | null;
  recordingAudioContext: AudioContext | null;
  onRecordingMessage: (message: string) => void;
  onStreamStarted?: () => void;
  onLeave: () => void;
};

type StreamAttendee = {
  identity: string;
  name: string;
  audienceType: StreamAudienceType;
};

type RegisteredChurch = {
  uid: string;
  churchName: string;
  churchLocation: string;
  churchType: "local" | "group";
  code: string | null;
  connected: boolean;
  connectedAt: string | null;
  accessEnabled?: boolean;
};

type ChurchActivity = { id: string; message: string; time: string };
type RemoteMediaTrack = { track: RemoteTrack; presenter: boolean; sourceId: string; sourceName: string };
type PresenterInvite = {
  id: string;
  active: boolean;
  claimed: boolean;
  presenterName: string;
  connected: boolean;
  connectedAt: string;
  disconnectedAt: string;
  createdAt: string;
  inviteUrl?: string;
};
type PresenterSourceTracks = { video: RemoteTrack | null; audio: RemoteTrack | null; name: string };
type PresenterFeed = { inviteId: string; name: string; video: RemoteTrack | null; hasAudio: boolean };
type SourceMode = "auto" | "studio" | "presenter" | "flier" | "flier-audio";
type SourceSelection = { mode: SourceMode; inviteId: string; flierKey: string; flierFileName: string };

type AccessAction =
  | { action: "get-state" }
  | { action: "set-all-access"; allAccess: boolean }
  | { action: "set-church-access"; churchAccess: boolean }
  | { action: "set-church-account-access"; churchUid: string; enabled: boolean }
  | { action: "set-individual-access"; individualAccess: boolean }
  | { action: "set-special-access"; specialAccess: boolean }
  | { action: "generate-code" }
  | { action: "set-code-access"; codeId: string; enabled: boolean }
  | { action: "enforce-access"; codeId?: string };

function getStreamAttendees(room: Room): StreamAttendee[] {
  return Array.from(room.remoteParticipants.values()).flatMap((participant) => {
    try {
      const metadata = JSON.parse(participant.metadata ?? "{}") as { audienceType?: unknown };
      if (metadata.audienceType !== "individual" && metadata.audienceType !== "church") return [];
      return [{
        identity: participant.identity,
        name: participant.name || (metadata.audienceType === "church" ? "Church account" : "Individual viewer"),
        audienceType: metadata.audienceType,
      }];
    } catch {
      return [];
    }
  });
}

function canViewerJoinWithCurrentPolicy(room: Room, audienceType: StreamAudienceType, developerPreview = false): boolean {
  if (developerPreview) return true;
  if (isPlatformViewerPaused(room.metadata)) return false;
  const policy = parsePublicStreamAccessPolicy(room.metadata);
  try {
    const metadata = JSON.parse(room.localParticipant.metadata ?? "{}") as {
      specialAccessCodeId?: unknown;
      developerSpecialAccessCodeId?: unknown;
      churchAccessKey?: unknown;
    };
    if (typeof metadata.specialAccessCodeId === "string") {
      const code = policy.specialAccessCodeStates.find((entry) => entry.id === metadata.specialAccessCodeId);
      return policy.specialAccess && Boolean(code?.enabled);
    }
    if (typeof metadata.developerSpecialAccessCodeId === "string") return true;
    if (audienceType === "church") {
      return policy.allAccess && policy.churchAccess &&
        !(typeof metadata.churchAccessKey === "string" && policy.blockedChurchAccessKeys.includes(metadata.churchAccessKey));
    }
    return policy.allAccess && policy.individualAccess;
  } catch {
    return false;
  }
}

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
  audienceType = "individual",
  accessCode,
  developerPreview = false,
  shareUrl,
  recordingFileHandle = null,
  recordingAudioContext,
  onRecordingMessage,
  onStreamStarted,
  onLeave,
}: LiveRoomProps) {
  const [room, setRoom] = useState<Room | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Connecting);
  const [localVideoTrack, setLocalVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [presenterFeeds, setPresenterFeeds] = useState<PresenterFeed[]>([]);
  const [remoteTracks, setRemoteTracks] = useState<RemoteMediaTrack[]>([]);
  const [attendees, setAttendees] = useState<StreamAttendee[]>([]);
  const [registeredChurches, setRegisteredChurches] = useState<RegisteredChurch[]>([]);
  const [churchActivity, setChurchActivity] = useState<ChurchActivity[]>([]);
  const [studioNotice, setStudioNotice] = useState("");
  const [viewerCount, setViewerCount] = useState(0);
  const [allAccess, setAllAccess] = useState(DEFAULT_STREAM_ACCESS_POLICY.allAccess);
  const [churchAccess, setChurchAccess] = useState(DEFAULT_STREAM_ACCESS_POLICY.churchAccess);
  const [individualAccess, setIndividualAccess] = useState(DEFAULT_STREAM_ACCESS_POLICY.individualAccess);
  const [platformViewerPaused, setPlatformViewerPaused] = useState(false);
  const [specialAccess, setSpecialAccess] = useState(DEFAULT_STREAM_ACCESS_POLICY.specialAccess);
  const [specialAccessCodes, setSpecialAccessCodes] = useState<PublicSpecialAccessCode[]>([]);
  const [newSpecialCode, setNewSpecialCode] = useState("");
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [accessMessage, setAccessMessage] = useState("");
  const [needsDisconnectRetry, setNeedsDisconnectRetry] = useState(false);
  const [disconnectRetryCodeId, setDisconnectRetryCodeId] = useState<string | undefined>();
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [audioNeedsGesture, setAudioNeedsGesture] = useState(false);
  const [error, setError] = useState("");
  const [ending, setEnding] = useState(false);
  const [recordingState, setRecordingState] = useState<"idle" | "recording" | "saving" | "saved" | "error">("idle");
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [recordingStartedTime, setRecordingStartedTime] = useState("");
  const [recordingFileName, setRecordingFileName] = useState("");
  const [presenterInvites, setPresenterInvites] = useState<PresenterInvite[]>([]);
  const presenterInvitesRef = useRef<PresenterInvite[]>([]);
  const [presenterBusy, setPresenterBusy] = useState(false);
  const [presenterError, setPresenterError] = useState("");
  const [sourceMode, setSourceMode] = useState<SourceMode>("auto");
  const [sourceInviteId, setSourceInviteId] = useState("");
  const [flierKey, setFlierKey] = useState("");
  const [flierFileName, setFlierFileName] = useState("");
  const [monitorStatus, setMonitorStatus] = useState<"waiting" | "connecting" | "connected" | "unavailable">("waiting");
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [flierBusy, setFlierBusy] = useState(false);
  const [flierError, setFlierError] = useState("");
  const [flierAudioSelection, setFlierAudioSelection] = useState("");
  const audioContainerRef = useRef<HTMLDivElement>(null);
  const recordingVideoRef = useRef<HTMLVideoElement>(null);
  const flierImageRef = useRef<HTMLImageElement>(null);
  const flierInputRef = useRef<HTMLInputElement>(null);
  const localRecorderRef = useRef<Awaited<ReturnType<typeof createLocalDeviceRecorder>> | null>(null);
  const presenterSourceTracksRef = useRef(new Map<string, PresenterSourceTracks>());
  const sourceSelectionRef = useRef<SourceSelection>({ mode: "auto", inviteId: "", flierKey: "", flierFileName: "" });
  const roomRef = useRef<Room | null>(null);
  const monitorRoomRef = useRef<Room | null>(null);
  const monitorTracksRef = useRef<MediaStreamTrack[]>([]);
  const monitorSyncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const applySourceSelectionRef = useRef<(selection: { mode?: unknown; inviteId?: unknown; flierKey?: unknown; flierFileName?: unknown }) => void>(() => undefined);
  const selectBroadcastSourceRef = useRef<(mode: SourceMode, inviteId?: string) => Promise<void>>(async () => undefined);
  const recordingStartedAtRef = useRef<number | null>(null);
  const stopRecordingPromiseRef = useRef<Promise<void> | null>(null);
  const stopRecordingRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const individualCountRef = useRef(0);
  const connectedAudienceRef = useRef(new Map<string, StreamAttendee>());
  const streamStartNotifiedRef = useRef(false);

  const addStudioActivity = useCallback((message: string) => {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setChurchActivity((current) => [{ id: `${Date.now()}-${Math.random()}`, message, time }, ...current].slice(0, 8));
    setStudioNotice(message);
  }, []);

  useEffect(() => {
    presenterInvitesRef.current = presenterInvites;
  }, [presenterInvites]);

  const syncAudience = useCallback((nextRoom: Room) => {
    const nextAttendees = getStreamAttendees(nextRoom);
    const previousAudience = connectedAudienceRef.current;
    const nextAudience = new Map<string, StreamAttendee>();
    nextAttendees.forEach((attendee) => nextAudience.set(attendee.identity, attendee));

    if (role === "host") {
      for (const attendee of nextAttendees) {
        if (attendee.audienceType === "church" && !previousAudience.has(attendee.identity)) {
          addStudioActivity(`${attendee.name} connected`);
        }
      }

      const previousIndividuals = individualCountRef.current;
      const nextIndividuals = nextAttendees.filter((attendee) => attendee.audienceType === "individual").length;
      individualCountRef.current = nextIndividuals;
      const reachedMilestones = [10, 20, 50, 100].filter((threshold) => previousIndividuals < threshold && nextIndividuals >= threshold);
      const milestone = reachedMilestones[reachedMilestones.length - 1];
      if (milestone) addStudioActivity(`${milestone} individual viewers are connected`);
    } else {
      individualCountRef.current = nextAttendees.filter((attendee) => attendee.audienceType === "individual").length;
    }

    connectedAudienceRef.current = nextAudience;
    setAttendees(nextAttendees);
    if (role === "viewer") setViewerCount(nextAttendees.length);
  }, [addStudioActivity, role]);

  const showRecordingMessage = useCallback((message: string) => {
    onRecordingMessage(message);
  }, [onRecordingMessage]);

  useEffect(() => {
    if (!studioNotice) return;
    const timeout = window.setTimeout(() => setStudioNotice(""), 5500);
    return () => window.clearTimeout(timeout);
  }, [studioNotice]);

  const stopRecording = useCallback(() => {
    if (stopRecordingPromiseRef.current) return stopRecordingPromiseRef.current;
    const recorder = localRecorderRef.current;
    if (!recorder) return Promise.resolve();

    localRecorderRef.current = null;
    setRecordingState("saving");
    const stopPromise = (async () => {
      try {
        const savedName = await recorder.stop();
        setRecordingFileName(savedName);
        setRecordingState("saved");
        showRecordingMessage(`Recording saved on this device: ${savedName}`);
      } catch (recordingError) {
        const message = recordingError instanceof Error ? recordingError.message : "The recording could not be saved on this device.";
        setRecordingState("error");
        setError(message);
        showRecordingMessage(message);
      }
    })();
    stopRecordingPromiseRef.current = stopPromise;
    void stopPromise.finally(() => {
      if (stopRecordingPromiseRef.current === stopPromise) stopRecordingPromiseRef.current = null;
    });
    return stopPromise;
  }, [showRecordingMessage]);

  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  const startRecording = useCallback(async (activeRoom: Room, isMounted: () => boolean) => {
    if (role !== "host" || localRecorderRef.current) return;
    const videoElement = recordingVideoRef.current;
    if (!videoElement) return;

    const cameraPublication = activeRoom.localParticipant.getTrackPublication(Track.Source.Camera);
    const microphonePublication = activeRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
    const selection = sourceSelectionRef.current;
    const isFlier = selection.mode === "flier" || selection.mode === "flier-audio";
    const selectedInviteId = selection.mode === "presenter" || selection.mode === "auto" || selection.mode === "flier-audio"
      ? selection.inviteId
      : "";
    const selectedPresenterTracks = selectedInviteId ? presenterSourceTracksRef.current.get(selectedInviteId) : undefined;
    try {
      const localRecorder = await createLocalDeviceRecorder({
        videoElement,
        videoTrack: isFlier ? null : selectedPresenterTracks?.video?.mediaStreamTrack ?? cameraPublication?.track?.mediaStreamTrack ?? null,
        audioTrack: selection.mode === "flier" ? null : selectedPresenterTracks?.audio?.mediaStreamTrack ?? microphonePublication?.track?.mediaStreamTrack ?? null,
        audioContext: recordingAudioContext,
        fileHandle: recordingFileHandle,
        title,
      });
      localRecorder.setVideoImage(isFlier ? flierImageRef.current : null);
      if (!isMounted() || activeRoom.state !== ConnectionState.Connected) {
        const savedName = await localRecorder.stop();
        setRecordingFileName(savedName);
        setRecordingState("saved");
        return;
      }

      localRecorderRef.current = localRecorder;
      recordingStartedAtRef.current = Date.now();
      setRecordingStartedTime(new Date(recordingStartedAtRef.current).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
      setRecordingElapsed(0);
      setRecordingState("recording");
      showRecordingMessage(recordingFileHandle
        ? "Recording started automatically. It is being saved on this device."
        : "Recording started automatically. Your browser will download it to this device when recording stops.");
    } catch (recordingError) {
      const message = recordingError instanceof Error ? recordingError.message : "Recording could not start on this device.";
      setRecordingState("error");
      setError(message);
      showRecordingMessage(message);
    }
  }, [recordingAudioContext, recordingFileHandle, role, showRecordingMessage, title]);

  const refreshRecordingSources = useCallback((activeRoom: Room) => {
    const selection = sourceSelectionRef.current;
    const isFlier = selection.mode === "flier" || selection.mode === "flier-audio";
    const selectedInviteId = selection.mode === "presenter" || selection.mode === "auto" || selection.mode === "flier-audio"
      ? selection.inviteId
      : "";
    const presenterTracks = selectedInviteId ? presenterSourceTracksRef.current.get(selectedInviteId) : undefined;
    const cameraTrack = activeRoom.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    const microphoneTrack = activeRoom.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    localRecorderRef.current?.setVideoTrack(isFlier ? null : presenterTracks?.video?.mediaStreamTrack ?? cameraTrack?.mediaStreamTrack ?? null);
    localRecorderRef.current?.setVideoImage(isFlier ? flierImageRef.current : null);
    localRecorderRef.current?.setAudioTrack(selection.mode === "flier" ? null : presenterTracks?.audio?.mediaStreamTrack ?? microphoneTrack?.mediaStreamTrack ?? null);
  }, []);

  const syncProgramMonitor = useCallback(() => {
    if (role !== "host") return Promise.resolve();

    monitorSyncQueueRef.current = monitorSyncQueueRef.current.catch(() => undefined).then(async () => {
      const monitorRoom = monitorRoomRef.current;
      const mainRoom = roomRef.current;
      if (!monitorRoom || monitorRoom.state !== ConnectionState.Connected || !mainRoom || mainRoom.state !== ConnectionState.Connected) return;

      const selection = sourceSelectionRef.current;
      const isFlier = selection.mode === "flier" || selection.mode === "flier-audio";
      const videoSourceId = selection.mode === "studio" || selection.mode === "auto" && !selection.inviteId
        ? "studio"
        : selection.mode === "presenter" || selection.mode === "auto"
          ? selection.inviteId
          : "";
      const audioSourceId = selection.mode === "flier"
        ? ""
        : isFlier
          ? selection.inviteId || "studio"
          : videoSourceId || "studio";
      const videoTrack = isFlier
        ? null
        : videoSourceId === "studio"
          ? mainRoom.localParticipant.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack ?? null
          : presenterSourceTracksRef.current.get(videoSourceId)?.video?.mediaStreamTrack ?? null;
      const audioTrack = !audioSourceId
        ? null
        : audioSourceId === "studio"
          ? mainRoom.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack ?? null
          : presenterSourceTracksRef.current.get(audioSourceId)?.audio?.mediaStreamTrack ?? null;

      const previousTracks = monitorTracksRef.current;
      monitorTracksRef.current = [];
      await Promise.all(previousTracks.map((track) => monitorRoom.localParticipant.unpublishTrack(track, false).catch(() => undefined)));
      previousTracks.forEach((track) => track.stop());

      const nextTracks: MediaStreamTrack[] = [];
      try {
        if (videoTrack?.readyState === "live") {
          const clone = videoTrack.clone();
          nextTracks.push(clone);
          await monitorRoom.localParticipant.publishTrack(clone, { source: Track.Source.Camera });
        }
        if (audioTrack?.readyState === "live") {
          const clone = audioTrack.clone();
          nextTracks.push(clone);
          await monitorRoom.localParticipant.publishTrack(clone, { source: Track.Source.Microphone });
        }
        monitorTracksRef.current = nextTracks;
        setMonitorStatus("connected");
      } catch {
        await Promise.all(nextTracks.map((track) => monitorRoom.localParticipant.unpublishTrack(track, false).catch(() => undefined)));
        nextTracks.forEach((track) => track.stop());
        setMonitorStatus("unavailable");
      }
    }).catch(() => {
      setMonitorStatus("unavailable");
    });

    return monitorSyncQueueRef.current;
  }, [role]);

  const connectProgramMonitor = useCallback(async (isMounted: () => boolean) => {
    if (role !== "host") return;
    setMonitorStatus("connecting");
    try {
      const response = await fetch("/api/stream/monitor-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, role: "studio" }),
      });
      const result = await response.json() as { error?: string; serverUrl?: string; participantToken?: string };
      if (!response.ok || !result.serverUrl || !result.participantToken) {
        throw new Error(result.error ?? "The presenter program monitor could not connect.");
      }

      const monitorRoom = new Room({ adaptiveStream: true, dynacast: true });
      await monitorRoom.connect(result.serverUrl, result.participantToken);
      if (!isMounted()) {
        await monitorRoom.disconnect();
        return;
      }
      monitorRoomRef.current?.removeAllListeners();
      await monitorRoomRef.current?.disconnect();
      monitorRoomRef.current = monitorRoom;
      monitorRoom.on(RoomEvent.Disconnected, () => {
        if (monitorRoomRef.current === monitorRoom) {
          monitorRoomRef.current = null;
          monitorTracksRef.current.forEach((track) => track.stop());
          monitorTracksRef.current = [];
          if (isMounted()) setMonitorStatus("unavailable");
        }
      });
      setMonitorStatus("connected");
      await syncProgramMonitor();
    } catch {
      if (isMounted()) setMonitorStatus("unavailable");
    }
  }, [role, roomName, syncProgramMonitor]);

  const refreshAccessState = useCallback(async () => {
    if (role !== "host") return;
    try {
      const [response, churchResponse] = await Promise.all([
        fetch("/api/stream/access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomName, action: "get-state" }),
        }),
        fetch(`/api/zonal/churches?roomName=${encodeURIComponent(roomName)}`),
      ]);
      if (!response.ok) return;
      const result = (await response.json()) as {
        allAccess?: boolean;
        churchAccess?: boolean;
        individualAccess?: boolean;
        specialAccess?: boolean;
        platformViewerPaused?: boolean;
        specialAccessCodes?: PublicSpecialAccessCode[];
      };
      if (typeof result.allAccess === "boolean") setAllAccess(result.allAccess);
      if (typeof result.churchAccess === "boolean") setChurchAccess(result.churchAccess);
      if (typeof result.individualAccess === "boolean") setIndividualAccess(result.individualAccess);
      if (typeof result.platformViewerPaused === "boolean") setPlatformViewerPaused(result.platformViewerPaused);
      if (typeof result.specialAccess === "boolean") setSpecialAccess(result.specialAccess);
      if (Array.isArray(result.specialAccessCodes)) setSpecialAccessCodes(result.specialAccessCodes);
      if (churchResponse.ok) {
        const churchResult = await churchResponse.json() as { churches?: RegisteredChurch[] };
        if (Array.isArray(churchResult.churches)) setRegisteredChurches(churchResult.churches);
      }
    } catch {
      // The host can still manage the current room if an attendance refresh fails.
    }
  }, [role, roomName]);

  const refreshPresenterInvites = useCallback(async () => {
    if (role !== "host") return;
    try {
      const response = await fetch(`/api/stream/presenter-invite?roomName=${encodeURIComponent(roomName)}`);
      if (!response.ok) return;
      const result = await response.json() as { invites?: PresenterInvite[] };
      const previousUrls = new Map(presenterInvitesRef.current.map((invite) => [invite.id, invite.inviteUrl]));
      setPresenterInvites((result.invites ?? []).map((invite) => ({ ...invite, inviteUrl: previousUrls.get(invite.id) })));
    } catch {
      // Presenter status can be retried on the next refresh.
    }
  }, [role, roomName]);

  const applySourceSelection = useCallback((selection: { mode?: unknown; inviteId?: unknown; flierKey?: unknown; flierFileName?: unknown }) => {
    const mode: SourceMode = selection.mode === "studio" || selection.mode === "presenter" || selection.mode === "flier" || selection.mode === "flier-audio" ? selection.mode : "auto";
    const nextSelection: SourceSelection = {
      mode,
      inviteId: (mode === "presenter" || mode === "auto" || mode === "flier-audio") && typeof selection.inviteId === "string" ? selection.inviteId : "",
      flierKey: typeof selection.flierKey === "string" ? selection.flierKey : sourceSelectionRef.current.flierKey,
      flierFileName: typeof selection.flierFileName === "string" ? selection.flierFileName : sourceSelectionRef.current.flierFileName,
    };
    const previousSelection = sourceSelectionRef.current;
    const changed = previousSelection.mode !== nextSelection.mode || previousSelection.inviteId !== nextSelection.inviteId || previousSelection.flierKey !== nextSelection.flierKey;
    sourceSelectionRef.current = nextSelection;
    setSourceMode(nextSelection.mode);
    setSourceInviteId(nextSelection.inviteId);
    if (changed && nextSelection.mode === "flier-audio") setFlierAudioSelection(nextSelection.inviteId);
    setFlierKey(nextSelection.flierKey);
    setFlierFileName(nextSelection.flierFileName);
    if (changed && roomRef.current) {
      refreshRecordingSources(roomRef.current);
      void syncProgramMonitor();
    }
  }, [refreshRecordingSources, syncProgramMonitor]);

  const refreshSourceSelection = useCallback(async () => {
    try {
      const response = await fetch(`/api/stream/source?roomName=${encodeURIComponent(roomName)}`);
      if (!response.ok) return;
      const result = await response.json() as { source?: { mode?: unknown; inviteId?: unknown; flierKey?: unknown; flierFileName?: unknown } };
      if (result.source) {
        applySourceSelection(result.source);
      }
    } catch {
      // Existing source state remains active if a refresh cannot reach the server.
    }
  }, [applySourceSelection, roomName]);

  const selectBroadcastSource = useCallback(async (mode: SourceMode, requestedInviteId?: string) => {
    if (role !== "host") return;
    const inviteId = mode === "auto"
      ? requestedInviteId ?? ""
      : mode === "presenter" || mode === "flier-audio"
        ? requestedInviteId ?? ""
        : "";
    setSourceBusy(true);
    setSourceError("");
    try {
      const response = await fetch("/api/stream/source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, mode, ...(inviteId ? { inviteId } : {}) }),
      });
      const result = await response.json() as { error?: string; source?: { mode?: unknown; inviteId?: unknown; flierKey?: unknown; flierFileName?: unknown } };
      if (!response.ok || !result.source) throw new Error(result.error ?? "Could not switch the live feed.");
      applySourceSelection(result.source);
      const payload = new TextEncoder().encode(JSON.stringify({ mode: result.source.mode, inviteId: result.source.inviteId, flierKey: result.source.flierKey, flierFileName: result.source.flierFileName }));
      await roomRef.current?.localParticipant.publishData(payload, { reliable: true, topic: "zonestream-source" }).catch(() => undefined);
      const feedLabel = mode === "presenter"
        ? presenterInvitesRef.current.find((invite) => invite.id === inviteId)?.presenterName || "a presenter"
        : mode === "studio" || mode === "auto"
          ? "Studio"
          : mode === "flier"
            ? "the service flier"
            : `the service flier with ${inviteId ? presenterInvitesRef.current.find((invite) => invite.id === inviteId)?.presenterName || "a presenter’s" : "Studio"} audio`;
      addStudioActivity(`Broadcast feed switched to ${feedLabel}`);
    } catch (sourceUpdateError) {
      setSourceError(sourceUpdateError instanceof Error ? sourceUpdateError.message : "Could not switch the live feed.");
    } finally {
      setSourceBusy(false);
    }
  }, [addStudioActivity, applySourceSelection, role, roomName]);

  useEffect(() => {
    applySourceSelectionRef.current = applySourceSelection;
    selectBroadcastSourceRef.current = selectBroadcastSource;
  }, [applySourceSelection, selectBroadcastSource]);

  const managePresenterInvite = useCallback(async (action: "create" | "revoke", inviteId?: string) => {
    setPresenterBusy(true);
    setPresenterError("");
    try {
      const response = await fetch("/api/stream/presenter-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, roomName, ...(action === "revoke" && inviteId ? { inviteId } : {}) }),
      });
      const result = await response.json() as { error?: string; invite?: PresenterInvite; inviteUrl?: string; revoked?: boolean };
      if (!response.ok) throw new Error(result.error ?? "Presenter access could not be updated.");
      if (action === "create" && result.invite && result.inviteUrl) {
        const inviteUrl = new URL(result.inviteUrl);
        inviteUrl.searchParams.set("title", title);
        setPresenterInvites((current) => [...current, { ...result.invite!, inviteUrl: inviteUrl.toString() }]);
        addStudioActivity("A remote presenter invite was created");
      } else {
        setPresenterInvites((current) => current.filter((invite) => invite.id !== inviteId));
        if (result.revoked) addStudioActivity("Remote presenter access was turned off");
        if (sourceSelectionRef.current.inviteId === inviteId && (sourceSelectionRef.current.mode === "presenter" || sourceSelectionRef.current.mode === "auto")) {
          void selectBroadcastSource("studio");
        } else if (sourceSelectionRef.current.mode === "flier-audio" && sourceSelectionRef.current.inviteId === inviteId) {
          void selectBroadcastSource("flier-audio");
        }
      }
    } catch (inviteError) {
      setPresenterError(inviteError instanceof Error ? inviteError.message : "Presenter access could not be updated.");
    } finally {
      setPresenterBusy(false);
    }
  }, [addStudioActivity, roomName, selectBroadcastSource, title]);

  const copyPresenterInvite = useCallback(async (inviteId: string) => {
    const inviteUrl = presenterInvites.find((invite) => invite.id === inviteId)?.inviteUrl;
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setPresenterError("Presenter invite copied. Send it privately to that presenter.");
    } catch {
      setPresenterError("Copy was blocked. Select and copy the invite link from its presenter row.");
    }
  }, [presenterInvites]);

  const uploadServiceFlier = useCallback(async (file: File) => {
    if (!room || role !== "host") return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size <= 0 || file.size > 8 * 1024 * 1024) {
      setFlierError("Choose a PNG, JPG, or WebP image up to 8 MB.");
      return;
    }

    setFlierBusy(true);
    setFlierError("");
    try {
      const prepareResponse = await fetch("/api/stream/flier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", roomName, fileName: file.name, mimeType: file.type, sizeBytes: file.size }),
      });
      const prepare = await prepareResponse.json() as { error?: string; objectKey?: string; uploadUrl?: string };
      if (!prepareResponse.ok || !prepare.objectKey || !prepare.uploadUrl) throw new Error(prepare.error ?? "Could not prepare the service-flier upload.");

      const uploadResponse = await fetch(prepare.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!uploadResponse.ok) throw new Error("The image could not be uploaded. Check the storage upload settings and try again.");

      const completeResponse = await fetch("/api/stream/flier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete", roomName, objectKey: prepare.objectKey, fileName: file.name, mimeType: file.type, sizeBytes: file.size }),
      });
      const complete = await completeResponse.json() as { error?: string; flier?: { objectKey: string; fileName: string } };
      if (!completeResponse.ok || !complete.flier) throw new Error(complete.error ?? "The uploaded service flier could not be verified.");

      applySourceSelectionRef.current({ mode: sourceSelectionRef.current.mode, inviteId: sourceSelectionRef.current.inviteId, flierKey: complete.flier.objectKey, flierFileName: complete.flier.fileName });
      setStudioNotice("Service flier uploaded and ready for the program.");
    } catch (uploadError) {
      setFlierError(uploadError instanceof Error ? uploadError.message : "The service flier could not be uploaded.");
    } finally {
      setFlierBusy(false);
      if (flierInputRef.current) flierInputRef.current.value = "";
    }
  }, [role, room, roomName]);

  const removeServiceFlier = useCallback(async () => {
    setFlierBusy(true);
    setFlierError("");
    try {
      const response = await fetch("/api/stream/flier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", roomName }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The service flier could not be removed.");
      applySourceSelectionRef.current({ mode: "studio", inviteId: "", flierKey: "", flierFileName: "" });
      setFlierAudioSelection("");
      const payload = new TextEncoder().encode(JSON.stringify({ mode: "studio", inviteId: "", flierKey: "", flierFileName: "" }));
      await roomRef.current?.localParticipant.publishData(payload, { reliable: true, topic: "zonestream-source" }).catch(() => undefined);
    } catch (removeError) {
      setFlierError(removeError instanceof Error ? removeError.message : "The service flier could not be removed.");
    } finally {
      setFlierBusy(false);
    }
  }, [roomName]);

  const reportParticipantActivity = useCallback((event: "connected" | "disconnected", participant: { identity: string; name?: string; metadata?: string }) => {
    if (role !== "host") return;
    try {
      const metadata = JSON.parse(participant.metadata ?? "{}") as {
        audienceType?: unknown;
        specialAccessCodeId?: unknown;
        developerSpecialAccessCodeId?: unknown;
      };
      if (metadata.audienceType !== "church" && metadata.audienceType !== "individual") return;
      void fetch("/api/stream/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomName,
          event,
          audienceType: metadata.audienceType,
          participantName: participant.name,
          participantIdentity: participant.identity,
          specialAccessCodeId: typeof metadata.specialAccessCodeId === "string" ? metadata.specialAccessCodeId : undefined,
          developerSpecialAccessCodeId: typeof metadata.developerSpecialAccessCodeId === "string" ? metadata.developerSpecialAccessCodeId : undefined,
        }),
      }).catch(() => undefined);
    } catch {
      // Ignore malformed participant metadata.
    }
  }, [role, roomName]);

  useEffect(() => {
    if (role !== "host") return;
    const interval = window.setInterval(() => void refreshAccessState(), 12000);
    return () => window.clearInterval(interval);
  }, [refreshAccessState, role]);

  useEffect(() => {
    if (role !== "host") return;
    void refreshPresenterInvites();
    const interval = window.setInterval(() => void refreshPresenterInvites(), 5000);
    return () => window.clearInterval(interval);
  }, [refreshPresenterInvites, role]);

  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return;
    void refreshSourceSelection();
    const interval = window.setInterval(() => void refreshSourceSelection(), role === "viewer" ? 2500 : 7000);
    return () => window.clearInterval(interval);
  }, [connectionState, refreshSourceSelection, role]);

  useEffect(() => {
    let isMounted = true;
    let roomIsReadyForPolicyUpdates = false;
    let activeRoom: Room | null = null;

    async function joinRoom() {
      try {
        const response = await fetch("/api/stream/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomName, participantName, role, audienceType, accessCode, developerPreview }),
        });
        const details = (await response.json()) as { error?: string; serverUrl?: string; participantToken?: string };

        if (!response.ok || !details.serverUrl || !details.participantToken) {
          throw new Error(details.error ?? "Could not prepare the stream connection.");
        }

        const nextRoom = new Room({ adaptiveStream: true, dynacast: true });
        activeRoom = nextRoom;
        roomRef.current = nextRoom;

        nextRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
          if (isMounted) setConnectionState(state);
        });
        nextRoom.on(RoomEvent.Reconnecting, () => {
          if (isMounted) setConnectionState(ConnectionState.Reconnecting);
        });
        nextRoom.on(RoomEvent.Reconnected, () => {
          if (isMounted) {
            setConnectionState(ConnectionState.Connected);
            syncAudience(nextRoom);
          }
        });
        nextRoom.on(RoomEvent.ParticipantConnected, (participant) => {
          if (isMounted) {
            reportParticipantActivity("connected", participant);
            syncAudience(nextRoom);
            try {
              const metadata = JSON.parse(participant.metadata ?? "{}") as { role?: unknown; remotePresenterInviteId?: unknown };
              if (role === "host" && metadata.role === "remote-presenter") addStudioActivity(`${participant.name || "Remote presenter"} connected as presenter`);
            } catch {
              // Ignore malformed participant metadata.
            }
            void refreshAccessState();
          }
        });
        nextRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
          if (isMounted) {
            reportParticipantActivity("disconnected", participant);
            syncAudience(nextRoom);
            try {
              const metadata = JSON.parse(participant.metadata ?? "{}") as { audienceType?: unknown; role?: unknown; remotePresenterInviteId?: unknown };
              if (metadata.audienceType === "church") {
                addStudioActivity(`${participant.name || "A church"} disconnected`);
              }
              if (metadata.role === "remote-presenter") {
                if (typeof metadata.remotePresenterInviteId === "string") presenterSourceTracksRef.current.delete(metadata.remotePresenterInviteId);
                setPresenterFeeds((current) => current.filter((feed) => feed.inviteId !== metadata.remotePresenterInviteId));
                refreshRecordingSources(nextRoom);
                addStudioActivity(`${participant.name || "Remote presenter"} disconnected`);
                if ((sourceSelectionRef.current.mode === "presenter" || sourceSelectionRef.current.mode === "auto") && sourceSelectionRef.current.inviteId === metadata.remotePresenterInviteId) {
                  void selectBroadcastSourceRef.current("studio");
                } else if (sourceSelectionRef.current.mode === "flier-audio" && sourceSelectionRef.current.inviteId === metadata.remotePresenterInviteId) {
                  void selectBroadcastSourceRef.current("flier-audio");
                }
                void syncProgramMonitor();
              }
            } catch {
              // Ignore malformed participant metadata.
            }
            void refreshAccessState();
          }
        });
        nextRoom.on(RoomEvent.ParticipantMetadataChanged, () => {
          if (isMounted) {
            syncAudience(nextRoom);
            void refreshAccessState();
          }
        });
        nextRoom.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
          if (!isMounted || topic !== "zonestream-source") return;
          try {
            const metadata = JSON.parse(participant?.metadata ?? "{}") as { audienceType?: unknown };
            if (metadata.audienceType !== "host") return;
            const message = JSON.parse(new TextDecoder().decode(payload)) as { mode?: unknown; inviteId?: unknown };
            applySourceSelectionRef.current(message);
          } catch {
            // Ignore data that is not a valid Studio source selection.
          }
        });
        nextRoom.on(RoomEvent.RoomMetadataChanged, (metadata) => {
          if (isMounted) {
            const policy = parsePublicStreamAccessPolicy(metadata);
            const ownerPausedViewers = isPlatformViewerPaused(metadata);
            setAllAccess(policy.allAccess);
            setChurchAccess(policy.churchAccess);
            setIndividualAccess(policy.individualAccess);
            setSpecialAccess(policy.specialAccess);
            if (role === "host") void refreshAccessState();

            if (roomIsReadyForPolicyUpdates && role === "viewer" && !canViewerJoinWithCurrentPolicy(nextRoom, audienceType, developerPreview)) {
              const viewerMetadata = JSON.parse(nextRoom.localParticipant.metadata ?? "{}") as { specialAccessCodeId?: unknown; developerSpecialAccessCodeId?: unknown };
              setError(ownerPausedViewers
                ? "The platform owner has paused viewer access. Your connection has been stopped."
                : typeof viewerMetadata.developerSpecialAccessCodeId === "string"
                  ? "Developer special access is no longer available. Your connection has been stopped."
                : typeof viewerMetadata.specialAccessCodeId === "string"
                ? policy.specialAccess
                  ? "The Zonal Church has turned off this special-access code."
                  : "The Zonal Church has turned off all special access for this service."
                : !policy.allAccess
                  ? "The Zonal Church has turned off church and regular individual access for this service."
                  : audienceType === "church"
                    ? "Church access is now paused for this service."
                    : "Regular individual access is now off. Use a special-access code to join.");
              void nextRoom.disconnect();
            }
          }
        });
        nextRoom.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
          let isPresenter = false;
          try {
            const metadata = JSON.parse(participant.metadata ?? "{}") as { role?: unknown; remotePresenterInviteId?: unknown; audienceType?: unknown };
            isPresenter = metadata.role === "remote-presenter";
            const sourceId = isPresenter && typeof metadata.remotePresenterInviteId === "string"
              ? metadata.remotePresenterInviteId
              : metadata.audienceType === "host" ? "studio" : "";
            const sourceName = isPresenter ? participant.name || "Remote presenter" : "Zonal Church";
            if (role === "host" && isPresenter && sourceId) {
              const sources = presenterSourceTracksRef.current.get(sourceId) ?? { video: null, audio: null, name: sourceName };
              sources.name = sourceName;
              if (track.kind === Track.Kind.Video) sources.video = track;
              if (track.kind === Track.Kind.Audio) sources.audio = track;
              presenterSourceTracksRef.current.set(sourceId, sources);
              setPresenterFeeds((current) => {
                const updated: PresenterFeed = { inviteId: sourceId, name: sourceName, video: sources.video, hasAudio: Boolean(sources.audio) };
                return [...current.filter((feed) => feed.inviteId !== sourceId), updated];
              });
              refreshRecordingSources(nextRoom);
              void syncProgramMonitor();
            }
            if (isMounted && role === "viewer") setRemoteTracks((currentTracks) => [...currentTracks, { track, presenter: isPresenter, sourceId, sourceName }]);
          } catch {
            // Ignore malformed participant metadata.
          }
        });
        nextRoom.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
          if (role === "host") {
            try {
              const metadata = JSON.parse(participant.metadata ?? "{}") as { role?: unknown; remotePresenterInviteId?: unknown };
              if (metadata.role === "remote-presenter" && typeof metadata.remotePresenterInviteId === "string") {
                const sources = presenterSourceTracksRef.current.get(metadata.remotePresenterInviteId);
                if (sources) {
                  if (track.kind === Track.Kind.Video) sources.video = null;
                  if (track.kind === Track.Kind.Audio) sources.audio = null;
                  if (!sources.video && !sources.audio) presenterSourceTracksRef.current.delete(metadata.remotePresenterInviteId);
                  setPresenterFeeds((current) => current.map((feed) => feed.inviteId === metadata.remotePresenterInviteId
                    ? { ...feed, video: sources.video, hasAudio: Boolean(sources.audio) }
                    : feed).filter((feed) => feed.video || feed.hasAudio));
                }
                refreshRecordingSources(nextRoom);
                void syncProgramMonitor();
              }
            } catch {
              // Ignore malformed participant metadata.
            }
          }
          if (isMounted && role === "viewer") setRemoteTracks((currentTracks) => currentTracks.filter((item) => item.track.sid !== track.sid));
        });
        nextRoom.on(RoomEvent.TrackMuted, () => {
          if (role === "host") void syncProgramMonitor();
        });
        nextRoom.on(RoomEvent.TrackUnmuted, () => {
          if (role === "host") void syncProgramMonitor();
        });
        nextRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => {
          if (isMounted) setAudioNeedsGesture(!nextRoom.canPlaybackAudio);
        });
        nextRoom.on(RoomEvent.Disconnected, () => {
          if (isMounted) {
            setConnectionState(ConnectionState.Disconnected);
            if (role === "host") stopRecordingRef.current();
            if (role === "viewer") {
              setViewerCount(0);
              setRemoteTracks([]);
            }
          }
        });

        await nextRoom.connect(details.serverUrl, details.participantToken);
        if (!isMounted) {
          await nextRoom.disconnect();
          return;
        }

        const currentPolicy = parsePublicStreamAccessPolicy(nextRoom.metadata);
        if (role === "viewer" && !canViewerJoinWithCurrentPolicy(nextRoom, audienceType, developerPreview)) {
          await nextRoom.disconnect();
          setConnectionState(ConnectionState.Disconnected);
          const viewerMetadata = JSON.parse(nextRoom.localParticipant.metadata ?? "{}") as { specialAccessCodeId?: unknown };
          setError(isPlatformViewerPaused(nextRoom.metadata)
            ? "The platform owner has paused viewer access. Your connection has been stopped."
            : typeof viewerMetadata.specialAccessCodeId === "string"
            ? "Special access for this code is off. Ask the Zonal Church to turn it on."
            : !currentPolicy.allAccess
              ? "Church and regular individual access is off for this service."
              : "Regular individual access is off. You’ll need a special-access code to join.");
          return;
        }

        roomIsReadyForPolicyUpdates = true;

        setRoom(nextRoom);
        syncAudience(nextRoom);
        setAllAccess(currentPolicy.allAccess);
        setIndividualAccess(currentPolicy.individualAccess);
        setSpecialAccess(currentPolicy.specialAccess);
        setConnectionState(ConnectionState.Connected);

        if (role === "host") void refreshAccessState();

        if (role === "host") {
          try {
            await nextRoom.localParticipant.enableCameraAndMicrophone();
          } catch {
            setError("Your local camera or microphone is unavailable. You can still use a remote presenter link for the live video and audio.");
          }
          const cameraTrack = nextRoom.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
          setLocalVideoTrack(cameraTrack?.kind === Track.Kind.Video ? (cameraTrack as LocalVideoTrack) : null);
          setCameraEnabled(Boolean(cameraTrack));
          setMicrophoneEnabled(Boolean(nextRoom.localParticipant.getTrackPublication(Track.Source.Microphone)?.track));
          if (!streamStartNotifiedRef.current) {
            streamStartNotifiedRef.current = true;
            onStreamStarted?.();
          }
          await startRecording(nextRoom, () => isMounted);
          await connectProgramMonitor(() => isMounted);
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
      const stopPromise = role === "host" ? stopRecordingRef.current() : Promise.resolve();
      if (recordingAudioContext && recordingAudioContext.state !== "closed") {
        void stopPromise.then(() => {
          if (recordingAudioContext.state !== "closed") return recordingAudioContext.close().catch(() => undefined);
        });
      }
      if (activeRoom) {
        activeRoom.removeAllListeners();
        void activeRoom.disconnect();
        if (roomRef.current === activeRoom) roomRef.current = null;
      }
      const monitorRoom = monitorRoomRef.current;
      monitorRoomRef.current = null;
      monitorTracksRef.current.forEach((track) => track.stop());
      monitorTracksRef.current = [];
      if (monitorRoom) {
        monitorRoom.removeAllListeners();
        void monitorRoom.disconnect();
      }
    };
  }, [accessCode, addStudioActivity, audienceType, connectProgramMonitor, developerPreview, onStreamStarted, participantName, recordingAudioContext, refreshAccessState, refreshRecordingSources, reportParticipantActivity, role, roomName, showRecordingMessage, startRecording, syncAudience, syncProgramMonitor]);

  useEffect(() => {
    if (role !== "host" && role !== "viewer") return;
    const dispatchStreamState = (active: boolean) => {
      window.dispatchEvent(new CustomEvent("zonestream:stream-state", { detail: { active } }));
    };
    dispatchStreamState(connectionState === ConnectionState.Connected);
    return () => dispatchStreamState(false);
  }, [connectionState, role]);

  useEffect(() => {
    if (recordingState !== "recording") return;
    const interval = window.setInterval(() => {
      const startedAt = recordingStartedAtRef.current;
      if (startedAt !== null) setRecordingElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [recordingState]);

  const toggleCamera = useCallback(async () => {
    if (!room) return;
    const enabled = !cameraEnabled;
    try {
      await room.localParticipant.setCameraEnabled(enabled);
      const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      setLocalVideoTrack(enabled && track?.kind === Track.Kind.Video ? (track as LocalVideoTrack) : null);
      setCameraEnabled(enabled);
      void syncProgramMonitor();
      setError("");
    } catch {
      setError("Could not access the camera. Check your browser permissions and try again.");
    }
  }, [cameraEnabled, room, syncProgramMonitor]);

  const toggleMicrophone = useCallback(async () => {
    if (!room) return;
    const enabled = !microphoneEnabled;
    try {
      await room.localParticipant.setMicrophoneEnabled(enabled);
      setMicrophoneEnabled(enabled);
      refreshRecordingSources(room);
      void syncProgramMonitor();
      setError("");
    } catch {
      setError("Could not access the microphone. Check your browser permissions and try again.");
    }
  }, [microphoneEnabled, refreshRecordingSources, room, syncProgramMonitor]);

  const leaveRoom = useCallback(async () => {
    if (ending) return;
    setEnding(true);
    setError("");

    if (role === "host" && room) {
      try {
        const response = await fetch("/api/stream/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomName }),
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
  }, [ending, onLeave, role, room, roomName]);

  const enableAudio = useCallback(async () => {
    try {
      await room?.startAudio();
      setAudioNeedsGesture(false);
    } catch {
      setError("Tap the browser’s audio permission prompt to hear the broadcast.");
    }
  }, [room]);

  const updateAccess = useCallback(async (action: AccessAction) => {
    setAccessBusy(true);
    setAccessError("");
    setAccessMessage("");

    try {
      const response = await fetch("/api/stream/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, ...action }),
      });
      const result = (await response.json()) as {
        error?: string;
        allAccess?: boolean;
        churchAccess?: boolean;
        individualAccess?: boolean;
        specialAccess?: boolean;
        specialAccessCodes?: PublicSpecialAccessCode[];
        generatedCode?: string;
        warning?: string;
        retryCodeId?: string;
      };

      if (
        !response.ok ||
        typeof result.allAccess !== "boolean" ||
        typeof result.churchAccess !== "boolean" ||
        typeof result.individualAccess !== "boolean" ||
        typeof result.specialAccess !== "boolean" ||
        !Array.isArray(result.specialAccessCodes)
      ) {
        throw new Error(result.error ?? "Could not update the room access settings.");
      }

      setAllAccess(result.allAccess);
      setChurchAccess(result.churchAccess);
      setIndividualAccess(result.individualAccess);
      setSpecialAccess(result.specialAccess);
      setSpecialAccessCodes(result.specialAccessCodes);
      setNeedsDisconnectRetry(Boolean(result.warning));
      setDisconnectRetryCodeId(result.retryCodeId);
      if (result.warning) setAccessError(result.warning);
      if (action.action === "generate-code") {
        setNewSpecialCode(result.generatedCode ?? "");
        if (!result.warning) addStudioActivity("A special-access code was generated");
      } else if (!result.warning && action.action === "set-all-access" && !action.allAccess) {
        setAccessMessage("Churches and regular individuals are disconnected. Special-access guests are unaffected.");
        addStudioActivity("All audience access was turned off");
      } else if (!result.warning && action.action === "set-all-access" && action.allAccess) {
        addStudioActivity("All audience access was turned on");
      } else if (!result.warning && action.action === "set-church-access" && !action.churchAccess) {
        setAccessMessage("Regular church accounts are disconnected. Individual and special access follow their own settings.");
        addStudioActivity("All regular church access was turned off");
      } else if (!result.warning && action.action === "set-church-access" && action.churchAccess) {
        addStudioActivity("All regular church access was turned on");
      } else if (!result.warning && action.action === "set-church-account-access") {
        const church = registeredChurches.find((entry) => entry.uid === action.churchUid);
        setAccessMessage(`${church?.churchName ?? "Church"} regular live access was turned ${action.enabled ? "on" : "off"}.`);
        addStudioActivity(`${church?.churchName ?? "A church"} regular live access was turned ${action.enabled ? "on" : "off"}`);
      } else if (!result.warning && action.action === "set-individual-access" && !action.individualAccess) {
        setAccessMessage("Regular individuals are disconnected. Churches and special-access guests are unaffected.");
        addStudioActivity("Regular individual access was turned off");
      } else if (!result.warning && action.action === "set-individual-access" && action.individualAccess) {
        addStudioActivity("Regular individual access was turned on");
      } else if (!result.warning && action.action === "set-special-access" && !action.specialAccess) {
        setAccessMessage("All special-access guests are disconnected. Regular audience settings are unchanged.");
        addStudioActivity("All special access was turned off");
      } else if (!result.warning && action.action === "set-special-access" && action.specialAccess) {
        addStudioActivity("All special access was turned on");
      } else if (!result.warning && action.action === "set-code-access" && !action.enabled) {
        setAccessMessage("That special-access guest has been disconnected.");
        addStudioActivity("A special-access connection was turned off");
      } else if (!result.warning && action.action === "set-code-access" && action.enabled) {
        addStudioActivity("A special-access connection was turned on");
      }
      if (action.action === "set-church-access" || action.action === "set-church-account-access") {
        void refreshAccessState();
      }
    } catch (updateError) {
      setAccessError(updateError instanceof Error ? updateError.message : "Could not update the room access settings.");
    } finally {
      setAccessBusy(false);
    }
  }, [addStudioActivity, refreshAccessState, registeredChurches, roomName]);

  const copySpecialCode = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setAccessMessage("Special-access code copied. Share it privately with one person or church.");
    } catch {
      setAccessError("Copy was blocked. Select and copy the code from the list.");
    }
  }, []);

  const flierOnAir = sourceMode === "flier" || sourceMode === "flier-audio";
  const onAirSourceId = flierOnAir
    ? "flier"
    : sourceMode === "studio"
      ? "studio"
      : sourceMode === "presenter"
        ? sourceInviteId
        : sourceInviteId || "studio";
  const onAirAudioSourceId = sourceMode === "flier"
    ? ""
    : sourceMode === "flier-audio"
      ? sourceInviteId || "studio"
      : onAirSourceId;
  const flierImageUrl = flierKey ? `/api/stream/flier?roomName=${encodeURIComponent(roomName)}&key=${encodeURIComponent(flierKey)}` : "";
  const selectedPresenterInvite = presenterInvites.find((invite) => invite.id === onAirSourceId);
  const selectedPresenterFeed = presenterFeeds.find((feed) => feed.inviteId === onAirSourceId);
  const remoteOnAirTrack = remoteTracks.find((entry) => entry.sourceId === onAirSourceId && entry.track.kind === Track.Kind.Video)?.track ?? null;
  const onAirVideoTrack: Track | null = flierOnAir
    ? null
    : role === "host"
      ? onAirSourceId === "studio" ? localVideoTrack : selectedPresenterFeed?.video ?? null
      : remoteOnAirTrack;
  const onAirFeedName = flierOnAir
    ? "Service flier"
    : onAirSourceId === "studio"
      ? "Studio"
      : selectedPresenterInvite?.presenterName || selectedPresenterFeed?.name || "Presenter";
  const individualAttendees = attendees.filter((attendee) => attendee.audienceType === "individual");
  const churchAttendees = attendees.filter((attendee) => attendee.audienceType === "church");
  const connectedChurchCount = registeredChurches.filter((church) => church.connected).length || churchAttendees.length;
  const audienceConnections = viewerCount + (connectionState === ConnectionState.Connected ? 1 : 0);
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

  useEffect(() => {
    const audioContainer = audioContainerRef.current;
    if (!audioContainer) return;

    const audioTracks = remoteTracks.filter((entry) => entry.sourceId === onAirAudioSourceId && entry.track.kind === Track.Kind.Audio);
    const attachedElements = audioTracks.map(({ track }) => {
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
  }, [onAirAudioSourceId, remoteTracks]);

  useEffect(() => {
    const isFlier = sourceMode === "flier" || sourceMode === "flier-audio";
    localRecorderRef.current?.setVideoImage(isFlier ? flierImageRef.current : null);
  }, [flierKey, sourceMode]);

  return (
    <section className={`live-room live-room-${role}`} aria-label={role === "host" ? "Broadcast studio" : "Live broadcast"}>
      {role === "host" ? <video ref={recordingVideoRef} className="live-room-record-source" autoPlay playsInline muted aria-hidden="true" /> : null}
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
          <span>{role === "host" ? `${individualAttendees.length} individual${individualAttendees.length === 1 ? "" : "s"}` : developerPreview ? "Private preview" : `${audienceConnections} connection${audienceConnections === 1 ? "" : "s"} watching`}</span>
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

      {role === "host" ? (
        <section className="live-room-presenter-panel" aria-labelledby="remote-presenter-title">
          <div className="live-room-presenter-heading">
            <div>
              <span className="live-room-section-eyebrow">LIVE PRODUCTION</span>
              <h3 id="remote-presenter-title">Choose what viewers see</h3>
            </div>
          </div>
          <p>Presenter cameras stay backstage until selected. The separate presenter monitor receives only the feed on air. You can also show a service flier by itself or with live audio.</p>
          <div className={`live-room-monitor-status is-${monitorStatus}`} role="status">
            <span />
            {monitorStatus === "connected" ? "Presenter program monitor is live" : monitorStatus === "connecting" ? "Connecting presenter program monitor…" : monitorStatus === "unavailable" ? "Presenter monitor unavailable; the audience stream is still running" : "Presenter program monitor is waiting"}
          </div>
          <div className="live-room-source-grid" aria-label="Available broadcast feeds">
            <button className={`live-room-source-card${onAirSourceId === "studio" ? " is-on-air" : ""}`} type="button" onClick={() => void selectBroadcastSource("studio")} disabled={sourceBusy || !connected} aria-pressed={onAirSourceId === "studio"}>
              <span className="live-room-source-preview">{localVideoTrack ? <AttachedVideo track={localVideoTrack} muted /> : <span className="live-room-source-placeholder">Studio camera is off</span>}</span>
              <span className="live-room-source-card-caption"><strong>Studio</strong><small>{onAirSourceId === "studio" ? "ON AIR" : "Select feed"}</small></span>
            </button>
            {presenterInvites.filter((invite) => invite.connected).map((invite) => {
              const feed = presenterFeeds.find((entry) => entry.inviteId === invite.id);
              return (
                <button className={`live-room-source-card${onAirSourceId === invite.id ? " is-on-air" : ""}`} key={invite.id} type="button" onClick={() => void selectBroadcastSource("presenter", invite.id)} disabled={sourceBusy || !connected} aria-pressed={onAirSourceId === invite.id}>
                  <span className="live-room-source-preview">{feed?.video ? <AttachedVideo track={feed.video} muted /> : <span className="live-room-source-placeholder">Waiting for camera</span>}</span>
                  <span className="live-room-source-card-caption"><strong>{invite.presenterName || feed?.name || "Presenter"}</strong><small>{onAirSourceId === invite.id ? "ON AIR" : "Select feed"}</small></span>
                </button>
              );
            })}
            {flierKey ? (
              <div className={`live-room-source-card live-room-flier-card${flierOnAir ? " is-on-air" : ""}`} aria-label="Service flier source">
                <span className="live-room-source-preview">{flierImageUrl ? <Image src={flierImageUrl} alt="Uploaded service flier preview" width={640} height={360} unoptimized /> : <span className="live-room-source-placeholder">Service flier uploaded</span>}</span>
                <span className="live-room-source-card-caption"><strong>{flierFileName || "Service flier"}</strong><small>{flierOnAir ? "ON AIR" : "READY"}</small></span>
              </div>
            ) : null}
          </div>
          {sourceError ? <p className="live-room-presenter-message" role="alert">{sourceError}</p> : null}

          <section className="live-room-flier-controls" aria-label="Service flier controls">
            <div className="live-room-flier-heading">
              <div>
                <strong>Service flier</strong>
                <span>{flierFileName ? `Ready: ${flierFileName}` : "Upload an image for this service (PNG, JPG, or WebP, up to 8 MB)."}</span>
              </div>
              <input
                ref={flierInputRef}
                className="live-room-flier-input"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void uploadServiceFlier(file);
                }}
              />
              <button type="button" onClick={() => flierInputRef.current?.click()} disabled={!connected || flierBusy}>
                {flierBusy ? "Uploading…" : flierKey ? "Replace flier" : "Upload flier"}
              </button>
              {flierKey ? <button className="live-room-flier-remove" type="button" onClick={() => void removeServiceFlier()} disabled={flierBusy}>Remove</button> : null}
            </div>
            {flierKey ? (
              <div className="live-room-flier-on-air-controls">
                <button type="button" className={sourceMode === "flier" ? "is-selected" : ""} onClick={() => void selectBroadcastSource("flier")} disabled={!connected || sourceBusy || flierBusy} aria-pressed={sourceMode === "flier"}>
                  Show flier only
                </button>
                <label>
                  Live audio source
                  <select value={flierAudioSelection} onChange={(event) => setFlierAudioSelection(event.currentTarget.value)} disabled={!connected || sourceBusy}>
                    <option value="">Studio microphone</option>
                    {presenterInvites.filter((invite) => invite.connected && presenterFeeds.some((feed) => feed.inviteId === invite.id && feed.hasAudio)).map((invite) => (
                      <option key={invite.id} value={invite.id}>{invite.presenterName || "Remote presenter"} microphone</option>
                    ))}
                  </select>
                </label>
                <button type="button" className={sourceMode === "flier-audio" ? "is-selected" : ""} onClick={() => void selectBroadcastSource("flier-audio", flierAudioSelection)} disabled={!connected || sourceBusy || flierBusy} aria-pressed={sourceMode === "flier-audio"}>
                  Show flier with live audio
                </button>
              </div>
            ) : null}
            {flierError ? <p className="live-room-presenter-message" role="alert">{flierError}</p> : null}
          </section>

          <div className="live-room-presenter-heading live-room-invite-heading">
            <div>
              <span className="live-room-section-eyebrow">REMOTE PRESENTER ACCESS</span>
              <h3>Presenter invites</h3>
            </div>
            <button className="live-room-generate-code" type="button" onClick={() => void managePresenterInvite("create")} disabled={!connected || presenterBusy}>
              <FiKey aria-hidden="true" /> {presenterBusy ? "Please wait…" : "Generate another invite"}
            </button>
          </div>
          <p>Each invite belongs to one signed-in account. You can have several presenters connected at the same time, and revoke any invite separately.</p>
          {presenterInvites.length ? (
            <ul className="live-room-presenter-list">
              {presenterInvites.map((invite) => (
                <li key={invite.id} className={onAirSourceId === invite.id ? "is-on-air" : ""}>
                  <div className="live-room-presenter-person">
                    <strong>{invite.presenterName || "Waiting for presenter"}</strong>
                    <span>{invite.connected ? "Connected" : invite.claimed ? "Signed in · disconnected" : "Invite not used"}</span>
                    {invite.connectedAt ? <time>Connected {new Date(invite.connectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> : null}
                    {invite.disconnectedAt ? <time>Disconnected {new Date(invite.disconnectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> : null}
                  </div>
                  <div className="live-room-presenter-row-actions">
                    {invite.inviteUrl ? <button type="button" onClick={() => void copyPresenterInvite(invite.id)}><FiCopy aria-hidden="true" /> Copy invite</button> : <small>Link is only shown when first generated</small>}
                    {invite.connected ? <button type="button" onClick={() => void selectBroadcastSource("presenter", invite.id)} disabled={sourceBusy}>{onAirSourceId === invite.id ? "On air" : "Put on air"}</button> : null}
                    <button className="live-room-presenter-revoke" type="button" onClick={() => void managePresenterInvite("revoke", invite.id)} disabled={!connected || presenterBusy}>Revoke</button>
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="live-room-presenter-link-note">No presenter invites yet. Generate one for each person who may present.</p>}
          {presenterError ? <p className="live-room-presenter-message" role="status">{presenterError}</p> : null}
        </section>
      ) : null}

      <div className="live-room-stage">
        {flierOnAir && flierImageUrl ? (
          <Image ref={flierImageRef} className="live-room-program-flier" src={flierImageUrl} alt={`${title} service flier`} width={1280} height={720} unoptimized onLoad={(event) => localRecorderRef.current?.setVideoImage(event.currentTarget)} />
        ) : onAirVideoTrack ? (
          <AttachedVideo track={onAirVideoTrack} muted={role === "host"} />
        ) : (
          <div className="live-room-placeholder">
            <span className="live-room-placeholder-icon" aria-hidden="true">▶</span>
            <strong>{connected ? `Waiting for ${onAirFeedName} video` : role === "host" ? "Camera preview will appear here" : "Joining the live room"}</strong>
            <span>{role === "host" ? "Choose Studio or a connected presenter as the broadcast source." : "Keep this page open while the selected feed connects."}</span>
          </div>
        )}
        <span className="live-room-name-tag">{onAirFeedName}</span>
        <div ref={audioContainerRef} className="live-room-audio" aria-hidden="true" />
      </div>

      {role === "host" ? (
        <div className="live-room-audience">
          <section className="live-room-attendance" aria-labelledby="connected-churches-title">
            <div className="live-room-section-heading">
              <div>
                <span className="live-room-section-eyebrow">LIVE AUDIENCE</span>
                <h3 id="connected-churches-title">Churches connected</h3>
              </div>
              <span className="live-room-count-badge" aria-label={`${connectedChurchCount} churches connected`}>{connectedChurchCount}</span>
            </div>

            {registeredChurches.length ? (
              <ul className="live-room-church-list">
                {registeredChurches.map((church) => (
                  <li key={church.uid} className={church.connected ? "is-connected" : "is-disconnected"}>
                    <span className="live-room-church-icon"><FaChurch aria-hidden="true" /></span>
                    <span className="live-room-church-details">
                      <strong className="live-room-church-name">{church.churchName}</strong>
                      <small>{church.churchType === "group" ? "Group church" : "Church"}{church.churchLocation ? ` · ${church.churchLocation}` : ""}</small>
                      {church.connected && church.code ? <code>Code {church.code}</code> : null}
                      {church.connected && church.connectedAt ? <small>Connected at {new Date(church.connectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small> : null}
                    </span>
                    <span className={`live-room-church-status ${church.connected ? "is-online" : "is-offline"}`}>{church.connected ? "Connected" : "Disconnected"}</span>
                    <button
                      className={`live-room-code-toggle ${church.accessEnabled === false ? "is-restricted" : "is-open"}`}
                      type="button"
                      aria-pressed={church.accessEnabled !== false}
                      onClick={() => void updateAccess({ action: "set-church-account-access", churchUid: church.uid, enabled: church.accessEnabled === false })}
                      disabled={accessBusy || !connected}
                      aria-label={`${church.accessEnabled === false ? "Allow" : "Pause"} regular live access for ${church.churchName}`}
                    >
                      {church.accessEnabled === false ? "Off" : "On"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="live-room-empty-audience">Registered churches will appear here as the Zonal Church creates their accounts.</p>
            )}
            {churchActivity.length ? <ul className="live-room-church-activity" aria-label="Recent studio activity">{churchActivity.map((activity) => <li key={activity.id}><span>{activity.message}</span><time>{activity.time}</time></li>)}</ul> : null}
          </section>

          <section className="live-room-access" aria-label="Audience access controls">
            <div className="live-room-section-heading">
              <div>
                <span className="live-room-section-eyebrow">ATTENDANCE RULES</span>
                <h3 id="all-audience-access-title">All audience access</h3>
              </div>
              <span className={`live-room-access-status ${allAccess ? "is-open" : "is-restricted"}`}>
                {allAccess ? "On" : "Off"}
              </span>
            </div>

            {platformViewerPaused ? (
              <p className="live-room-owner-pause-notice"><FiAlertTriangle aria-hidden="true" /> The platform owner has paused viewer access. Church and regular individual connections are blocked until it is resumed.</p>
            ) : null}

            <p className="live-room-access-description">
              {allAccess
                ? "Church accounts can join. Regular individual access follows the separate setting below."
                : "Churches and regular individuals are disconnected. Special-access guests are controlled separately."}
            </p>

            <button
              className={`live-room-access-toggle ${allAccess ? "is-open" : "is-restricted"}`}
              type="button"
              aria-pressed={allAccess}
              onClick={() => void updateAccess({ action: "set-all-access", allAccess: !allAccess })}
              disabled={accessBusy || !connected}
            >
              <span className="live-room-toggle-indicator" aria-hidden="true"><span /></span>
              <span>{allAccess ? "All audience access on" : "All audience access off"}</span>
            </button>

            <div className="live-room-access-divider" />

            <div className="live-room-section-heading live-room-individual-heading">
              <div>
                <span className="live-room-section-eyebrow">CHURCHES</span>
                <h3 id="church-access-title">Regular church access</h3>
              </div>
              <span className={`live-room-access-status ${churchAccess ? "is-open" : "is-restricted"}`}>
                {churchAccess ? "On" : "Off"}
              </span>
            </div>

            <p className="live-room-access-description">
              {churchAccess
                ? "Registered church accounts can join when all audience access is on. Each church also has its own switch in the church list above."
                : "Regular church accounts are paused. Special-access codes have their own controls."}
            </p>

            <button
              className={`live-room-access-toggle ${churchAccess ? "is-open" : "is-restricted"}`}
              type="button"
              aria-pressed={churchAccess}
              onClick={() => void updateAccess({ action: "set-church-access", churchAccess: !churchAccess })}
              disabled={accessBusy || !connected}
            >
              <span className="live-room-toggle-indicator" aria-hidden="true"><span /></span>
              <span>{churchAccess ? "All regular church access on" : "All regular church access off"}</span>
            </button>

            <div className="live-room-access-divider" />

            <div className="live-room-section-heading live-room-individual-heading">
              <div>
                <span className="live-room-section-eyebrow">INDIVIDUALS</span>
                <h3 id="individual-access-title">Regular individual access</h3>
              </div>
              <span className={`live-room-access-status ${individualAccess ? "is-open" : "is-restricted"}`}>
                {individualAccess ? "On" : "Off"}
              </span>
            </div>

            <p className="live-room-access-description">
              {!allAccess
                ? "When church and audience access is turned back on, this setting decides whether regular individuals can join."
                : individualAccess
                  ? "Regular individuals can join. Turning this off disconnects them; churches and special-code guests stay connected."
                  : "Regular individuals are paused. Churches and special-code guests remain governed by their own settings."}
            </p>

            <button
              className={`live-room-access-toggle ${individualAccess ? "is-open" : "is-restricted"}`}
              type="button"
              aria-pressed={individualAccess}
              onClick={() => void updateAccess({ action: "set-individual-access", individualAccess: !individualAccess })}
              disabled={accessBusy || !connected}
            >
              <span className="live-room-toggle-indicator" aria-hidden="true"><span /></span>
              <span>{individualAccess ? "Regular individual access on" : "Regular individual access off"}</span>
            </button>

            <div className="live-room-access-divider" />

            <section className="live-room-special-access" aria-labelledby="special-access-title">
              <div className="live-room-section-heading">
                <div>
                  <span className="live-room-section-eyebrow">INDIVIDUALS & CHURCHES</span>
                  <h3 id="special-access-title">Special access</h3>
                </div>
                <span className={`live-room-access-status ${specialAccess ? "is-open" : "is-restricted"}`}>
                  {specialAccess ? "On" : "Off"}
                </span>
              </div>

              <p className="live-room-access-description">
                Special codes can be used by an individual or a church. Their access is separate from both regular-access switches above.
              </p>

              <button
                className={`live-room-access-toggle ${specialAccess ? "is-open" : "is-restricted"}`}
                type="button"
                aria-pressed={specialAccess}
                onClick={() => void updateAccess({ action: "set-special-access", specialAccess: !specialAccess })}
                disabled={accessBusy || !connected}
              >
                <span className="live-room-toggle-indicator" aria-hidden="true"><span /></span>
                <span>{specialAccess ? "All special access on" : "All special access off"}</span>
              </button>

              <div className="live-room-code-heading">
                <div>
                  <h4>Special-access codes</h4>
                  <p>Each code is for one account in this live service.</p>
                </div>
                <button
                  className="live-room-generate-code"
                  type="button"
                  onClick={() => void updateAccess({ action: "generate-code" })}
                  disabled={accessBusy || !connected}
                >
                  <FiKey aria-hidden="true" /> Generate code
                </button>
              </div>

              {newSpecialCode ? (
                <div className="live-room-generated-code" role="status">
                  <div>
                    <span><FiCheck aria-hidden="true" /> New code ready to share</span>
                    <code>{newSpecialCode}</code>
                  </div>
                  <button type="button" onClick={() => void copySpecialCode(newSpecialCode)}>
                    <FiCopy aria-hidden="true" /> Copy code
                  </button>
                  <button className="live-room-dismiss-code" type="button" onClick={() => setNewSpecialCode("")}>Done</button>
                </div>
              ) : null}

              {specialAccessCodes.length ? (
                <ul className="live-room-special-code-list" aria-label="Special-access codes">
                  {specialAccessCodes.map((code) => (
                    <li key={code.id} className={code.enabled ? "is-enabled" : "is-disabled"}>
                      <div className="live-room-special-code-details">
                        <code>{code.code}</code>
                        {code.name ? (
                          <span className="live-room-special-code-name">
                            {code.name}
                            <small>{code.audienceType === "church" ? "Church account" : "Individual account"}</small>
                          </span>
                        ) : (
                          <span className="live-room-special-code-name">
                            Waiting to be used
                            <small>Unused code</small>
                          </span>
                        )}
                      </div>
                      <span className={`live-room-special-code-presence ${code.connected ? "is-connected" : ""}`}>
                        {code.name ? code.connected ? "Connected" : "Used · not connected" : "Not used"}
                      </span>
                      {code.connectedAt || code.disconnectedAt ? (
                        <span className="live-room-special-code-times">
                          {code.connectedAt ? <small>Connected {new Date(code.connectedAt).toLocaleString()}</small> : null}
                          {code.disconnectedAt ? <small>Disconnected {new Date(code.disconnectedAt).toLocaleString()}</small> : null}
                        </span>
                      ) : null}
                      <button
                        className={`live-room-code-toggle ${code.enabled ? "is-open" : "is-restricted"}`}
                        type="button"
                        aria-pressed={code.enabled}
                        onClick={() => void updateAccess({ action: "set-code-access", codeId: code.id, enabled: !code.enabled })}
                        disabled={accessBusy || !connected || !code.name}
                        aria-label={`${code.enabled ? "Turn off" : "Turn on"} special access for ${code.name ?? "unused code"}`}
                      >
                        {code.enabled ? "On" : "Off"}
                      </button>
                      {!code.name ? (
                        <button className="live-room-copy-code" type="button" onClick={() => void copySpecialCode(code.code)} aria-label={`Copy code ${code.code}`}>
                          <FiCopy aria-hidden="true" />
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="live-room-empty-codes">No special codes generated yet.</p>
              )}
            </section>

            {accessError ? <p className="live-room-access-error" role="status">{accessError}</p> : null}
            {accessMessage ? <p className="live-room-access-message" role="status">{accessMessage}</p> : null}
            {needsDisconnectRetry ? (
              <button className="live-room-retry-disconnect" type="button" onClick={() => void updateAccess({ action: "enforce-access", ...(disconnectRetryCodeId ? { codeId: disconnectRetryCodeId } : {}) })} disabled={accessBusy}>
                Try disconnecting blocked attendees again
              </button>
            ) : null}
              <p className="live-room-access-footnote"><FiUsers aria-hidden="true" /> {!allAccess
              ? "Churches and regular individuals are off. Special-access guests follow the controls in this section."
              : individualAccess
                ? `${individualAttendees.length} individual${individualAttendees.length === 1 ? "" : "s"} connected. Turning regular individual access off leaves special-access guests connected.`
                : `${individualAttendees.length} individual${individualAttendees.length === 1 ? "" : "s"} connected, including special-access guests. Regular access is paused; churches remain allowed.`}</p>
          </section>
        </div>
      ) : null}

      {audioNeedsGesture && role === "viewer" ? (
        <button className="live-room-audio-prompt" type="button" onClick={() => void enableAudio()}>
          <FiVolume2 aria-hidden="true" /> Tap to enable broadcast audio
        </button>
      ) : null}

      {error ? <p className={`live-room-message ${error.includes("copied") ? "is-success" : ""}`} role="status">{error}</p> : null}

      {role === "host" && studioNotice ? <div className="live-room-studio-toast" role="status" aria-live="polite"><FiUsers aria-hidden="true" /><span>{studioNotice}</span></div> : null}

      {role === "host" ? (
        <>
        <div className={`live-room-recording ${recordingState === "recording" ? "is-recording" : ""}`} aria-live="polite">
          <div className="live-room-recording-status">
            <span className="live-room-recording-dot" aria-hidden="true" />
            <span>
              <strong>{recordingState === "recording" ? "Recording this service" : recordingState === "saving" ? "Saving recording" : recordingState === "saved" ? "Recording saved" : recordingState === "error" ? "Recording unavailable" : "Automatic recording"}</strong>
              <small>
                {recordingState === "recording"
                  ? `${Math.floor(recordingElapsed / 60).toString().padStart(2, "0")}:${(recordingElapsed % 60).toString().padStart(2, "0")} recorded · started ${recordingStartedTime} · saved on this device`
                  : recordingState === "saved"
                    ? recordingFileName
                    : recordingState === "saving"
                      ? "Finishing the video file on this device…"
                      : "Starts when the live service connects"}
              </small>
            </span>
          </div>
          {recordingState === "recording" ? (
            <button className="live-room-recording-stop" type="button" onClick={() => void stopRecording()}>
              <FiSquare aria-hidden="true" /> Stop recording
            </button>
          ) : recordingState === "saving" ? (
            <span className="live-room-recording-saving"><FiHardDrive aria-hidden="true" /> Saving…</span>
          ) : recordingState === "error" && connected ? (
            <button className="live-room-recording-stop" type="button" onClick={() => room && void startRecording(room, () => true)}>
              Try recording again
            </button>
          ) : null}
        </div>
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
        </>
      ) : (
        <div className="live-room-controls live-room-viewer-controls">
          <span className="live-room-listen-note">You’re watching as {participantName}</span>
          {!connected && error ? (
            <button className="live-room-control live-room-return" type="button" onClick={onLeave}>
              Return to join options
            </button>
          ) : null}
          <button className="live-room-control live-room-end" type="button" onClick={() => void leaveRoom()} disabled={ending}>
            <FiPhoneOff aria-hidden="true" />
            <span>Leave stream</span>
          </button>
        </div>
      )}
    </section>
  );
}
