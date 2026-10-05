export type StreamRole = "host" | "viewer";
export type StreamAudienceType = "individual" | "church" | "developer";

export type StreamSession = {
  roomName: string;
  title: string;
  participantName: string;
  shareUrl: string;
};
