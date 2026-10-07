import "server-only";
import { getFirebaseAdmin } from "../firebase/admin";
import { buildServiceReport, type AttendanceSession } from "./service-report";
import { decryptPrivateSpecialAccessState, decryptSpecialAccessCode } from "./special-access-crypto";
import { parseStreamAccessPolicy } from "./access-policy";

export type AttendanceParticipant = { sid: string; identity: string; name?: string; metadata?: string; joinedAt?: bigint | number };
const serviceRef = (roomName: string) => getFirebaseAdmin().firestore.collection("serviceReports").doc(roomName);

export async function recordAttendance(roomName: string, participant: AttendanceParticipant, event: "connected" | "disconnected", at = new Date().toISOString(), roomMetadata = "") {
  let metadata: Record<string, unknown>;
  try { metadata = JSON.parse(participant.metadata || "{}"); } catch { return; }
  const audienceType = metadata.role === "remote-presenter" ? "presenter" : metadata.audienceType;
  if (audienceType !== "church" && audienceType !== "individual" && audienceType !== "presenter") return;
  if (metadata.developerPreview === true || !participant.sid) return;
  const privateDeveloper = typeof metadata.developerSpecialAccessCodeId === "string";
  let specialAccessCode: string | null = null;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (secret && typeof metadata.specialAccessCodeId === "string") {
    const policy = parseStreamAccessPolicy(roomMetadata, (value) => decryptPrivateSpecialAccessState(value, secret));
    const code = policy.specialAccessCodes.find((entry) => entry.id === metadata.specialAccessCodeId);
    if (code) specialAccessCode = decryptSpecialAccessCode(code.encryptedCode, secret);
  }
  if (privateDeveloper && secret) {
    const code = await getFirebaseAdmin().firestore.collection("developerSpecialAccessCodes").doc(metadata.developerSpecialAccessCodeId as string).get();
    if (typeof code.get("encryptedCode") === "string") specialAccessCode = decryptSpecialAccessCode(code.get("encryptedCode"), secret);
  }
  const ref = serviceRef(roomName);
  const sessionRef = ref.collection("sessions").doc(participant.sid);
  await getFirebaseAdmin().firestore.runTransaction(async (transaction) => {
    const [service, previous] = await Promise.all([transaction.get(ref), transaction.get(sessionRef)]);
    if (!service.exists) return;
    const endedAt = service.get("endedAt");
    if (endedAt && Date.parse(at) > Date.parse(endedAt)) return;
    if (previous.exists) {
      const updates: Record<string, string> = {};
      if (event === "disconnected" && (!previous.get("disconnectedAt") || Date.parse(at) < Date.parse(previous.get("disconnectedAt")))) updates.disconnectedAt = at;
      const joined = Number(participant.joinedAt ?? 0) * 1000;
      if (joined > 0 && joined < Date.parse(previous.get("connectedAt"))) updates.connectedAt = new Date(Math.max(joined, Date.parse(service.get("startedAt")))).toISOString();
      if (Object.keys(updates).length) transaction.update(sessionRef, updates);
      return;
    }
    const joined = Number(participant.joinedAt ?? 0) * 1000;
    const connectedAt = joined > 0 ? new Date(Math.max(joined, Date.parse(service.get("startedAt")))).toISOString() : at;
    const session: AttendanceSession = { id: participant.sid, identity: participant.identity,
      accountUid: typeof metadata.accountUid === "string" ? metadata.accountUid : participant.identity,
      name: participant.name || "Viewer", audienceType, connectedAt,
      disconnectedAt: event === "disconnected" ? at : null, specialAccessCode, privateDeveloper };
    transaction.create(sessionRef, session);
  });
}

export async function reconcileAttendance(roomName: string, participants: AttendanceParticipant[], roomMetadata = "") {
  const active = await serviceRef(roomName).collection("sessions").where("disconnectedAt", "==", null).get();
  const present = new Set(participants.map((participant) => participant.sid));
  const recorded = new Set(active.docs.map((doc) => doc.id));
  const now = new Date().toISOString();
  await Promise.all(participants.filter((participant) => !recorded.has(participant.sid)).map((participant) => recordAttendance(roomName, participant, "connected", now, roomMetadata)));
  await Promise.all(active.docs.filter((doc) => !present.has(doc.id)).map(async (doc) => {
    await getFirebaseAdmin().firestore.runTransaction(async (transaction) => {
      const [service, latest] = await Promise.all([transaction.get(serviceRef(roomName)), transaction.get(doc.ref)]);
      if (!service.get("endedAt") && latest.exists && !latest.get("disconnectedAt")) transaction.update(doc.ref, { disconnectedAt: now });
    });
  }));
}

export async function finishAttendance(roomName: string, participants: AttendanceParticipant[], endedAt: string) {
  const individuals = participants.flatMap((participant) => {
    try {
      const metadata = JSON.parse(participant.metadata || "{}");
      return metadata.audienceType === "individual" && !metadata.developerPreview && typeof metadata.developerSpecialAccessCodeId !== "string" ? [metadata.accountUid || participant.identity] : [];
    } catch { return []; }
  });
  await getFirebaseAdmin().firestore.runTransaction(async (transaction) => {
    const ref = serviceRef(roomName);
    const service = await transaction.get(ref);
    if (service.exists && !service.get("endedAt")) transaction.update(ref, { endedAt, finalIndividualCount: new Set(individuals).size });
  });
}

export async function getServiceReport(roomName: string, includePrivate: boolean) {
  const ref = serviceRef(roomName);
  const [service, sessions] = await Promise.all([ref.get(), ref.collection("sessions").get()]);
  if (!service.exists) return null;
  return buildServiceReport({ roomName, title: service.get("title"), startedAt: service.get("startedAt"), endedAt: service.get("endedAt"), finalIndividualCount: service.get("finalIndividualCount") },
    sessions.docs.map((doc) => doc.data() as AttendanceSession), includePrivate);
}
