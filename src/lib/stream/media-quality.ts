import { VideoPresets, type RoomOptions } from "livekit-client";

// Send multiple resolutions so each connection can adapt without lowering the source recording.
export const STREAM_ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  videoCaptureDefaults: { resolution: { width: 1920, height: 1080, frameRate: 30 } },
  publishDefaults: {
    simulcast: true,
    videoEncoding: { maxBitrate: 4_500_000, maxFramerate: 30 },
    videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
  },
};
