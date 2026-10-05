import "server-only";

import { getFirebaseAdmin } from "../firebase/admin";

export type PlatformActorType = "zonal" | "developer" | "church" | "individual" | "system";

export async function recordPlatformActivity(input: {
  action: string;
  label: string;
  actorType: PlatformActorType;
  actorName?: string;
  subjectName?: string;
  subjectId?: string;
  roomName?: string;
}) {
  try {
    await getFirebaseAdmin().firestore.collection("platformActivity").add({
      action: input.action.slice(0, 80),
      label: input.label.slice(0, 220),
      actorType: input.actorType,
      ...(input.actorName ? { actorName: input.actorName.slice(0, 120) } : {}),
      ...(input.subjectName ? { subjectName: input.subjectName.slice(0, 120) } : {}),
      ...(input.subjectId ? { subjectId: input.subjectId.slice(0, 100) } : {}),
      ...(input.roomName ? { roomName: input.roomName.slice(0, 100) } : {}),
      at: new Date().toISOString(),
    });
  } catch {
    // Activity logging must not interrupt the platform action being recorded.
  }
}
