export type StreamRole = "host" | "viewer";

export type StreamSession = {
  roomName: string;
  title: string;
  participantName: string;
  shareUrl: string;
  hostPin?: string;
};
