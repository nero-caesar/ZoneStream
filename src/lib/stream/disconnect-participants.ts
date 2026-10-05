import type { RoomServiceClient } from "livekit-server-sdk";

type Participant = { identity: string; metadata?: string };

export async function disconnectRoomParticipants(
  roomService: RoomServiceClient,
  roomName: string,
  shouldDisconnect: (participant: Participant) => boolean,
) {
  const revokeTokenTs = BigInt(Math.floor(Date.now() / 1000) + 1);
  const previouslyConnected = new Set<string>();
  let remaining: Participant[] = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const participants = await roomService.listParticipants(roomName);
    const blocked = participants.filter(shouldDisconnect);
    blocked.forEach((participant) => previouslyConnected.add(participant.identity));
    if (blocked.length === 0) {
      return { disconnectedCount: previouslyConnected.size, remainingCount: 0 };
    }

    await Promise.allSettled(blocked.map((participant) =>
      roomService.removeParticipant(roomName, participant.identity, { revokeTokenTs }),
    ));
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    remaining = (await roomService.listParticipants(roomName)).filter(shouldDisconnect);
    if (remaining.length === 0) {
      return { disconnectedCount: previouslyConnected.size, remainingCount: 0 };
    }
  }

  return {
    disconnectedCount: previouslyConnected.size - remaining.length,
    remainingCount: remaining.length,
  };
}
