import type { DocumentData } from "firebase-admin/firestore";
import { getFirebaseAdmin } from "../firebase/admin";
import { hashSpecialAccessCode, matchesSpecialAccessCode } from "./special-access-crypto";

export type DeveloperSpecialAccessMode = "temporal" | "permanent";
export type DeveloperSpecialAccessAudience = "individual" | "church";

export type DeveloperSpecialAccessRedeemedBy = {
  uid: string;
  name: string;
  audienceType: DeveloperSpecialAccessAudience;
  identity: string;
  firstConnectedAt: string;
  lastConnectedAt: string;
  lastDisconnectedAt?: string;
  lastRoomName: string;
  roomName?: string;
};

export type DeveloperSpecialAccessRecord = {
  id: string;
  mode: DeveloperSpecialAccessMode;
  codeHash: string;
  encryptedCode: string;
  enabled: boolean;
  createdAt: string;
  redeemedBy?: DeveloperSpecialAccessRedeemedBy;
};

export type DeveloperSpecialAccessGrantResult =
  | { status: "not-found" }
  | { status: "denied"; message: string }
  | { status: "granted"; record: DeveloperSpecialAccessRecord; identity: string };

const COLLECTION = "developerSpecialAccessCodes";
const MAX_CODES = 100;

function parseRecord(id: string, data: DocumentData | undefined): DeveloperSpecialAccessRecord | null {
  if (
    !data ||
    (data.mode !== "temporal" && data.mode !== "permanent") ||
    typeof data.codeHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(data.codeHash) ||
    typeof data.encryptedCode !== "string"
  ) return null;

  const rawRedeemed = data.redeemedBy;
  const redeemedBy = rawRedeemed &&
    typeof rawRedeemed.uid === "string" &&
    typeof rawRedeemed.name === "string" &&
    (rawRedeemed.audienceType === "individual" || rawRedeemed.audienceType === "church") &&
    typeof rawRedeemed.identity === "string" &&
    typeof rawRedeemed.firstConnectedAt === "string" &&
    typeof rawRedeemed.lastConnectedAt === "string" &&
    typeof rawRedeemed.lastRoomName === "string"
    ? {
        uid: rawRedeemed.uid,
        name: rawRedeemed.name,
        audienceType: rawRedeemed.audienceType as DeveloperSpecialAccessAudience,
        identity: rawRedeemed.identity,
        firstConnectedAt: rawRedeemed.firstConnectedAt,
        lastConnectedAt: rawRedeemed.lastConnectedAt,
        ...(typeof rawRedeemed.lastDisconnectedAt === "string" ? { lastDisconnectedAt: rawRedeemed.lastDisconnectedAt } : {}),
        lastRoomName: rawRedeemed.lastRoomName,
        ...(typeof rawRedeemed.roomName === "string" ? { roomName: rawRedeemed.roomName } : {}),
      }
    : undefined;

  return {
    id,
    mode: data.mode,
    codeHash: data.codeHash,
    encryptedCode: data.encryptedCode,
    enabled: data.enabled !== false,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    ...(redeemedBy ? { redeemedBy } : {}),
  };
}

export async function listDeveloperSpecialAccessCodes(): Promise<DeveloperSpecialAccessRecord[]> {
  const snapshot = await getFirebaseAdmin().firestore
    .collection(COLLECTION)
    .orderBy("createdAt", "desc")
    .limit(MAX_CODES)
    .get();
  return snapshot.docs.flatMap((document) => {
    const record = parseRecord(document.id, document.data());
    return record ? [record] : [];
  });
}

export async function findDeveloperSpecialAccessCode(code: string, secret: string): Promise<DeveloperSpecialAccessRecord | null> {
  const codeHash = hashSpecialAccessCode(code, secret);
  const snapshot = await getFirebaseAdmin().firestore.collection(COLLECTION)
    .where("codeHash", "==", codeHash)
    .limit(1)
    .get();
  const document = snapshot.docs[0];
  const record = document ? parseRecord(document.id, document.data()) : null;
  return record && matchesSpecialAccessCode(code, record.codeHash, secret) ? record : null;
}

export async function claimDeveloperSpecialAccessCode(input: {
  code: string;
  uid: string;
  name: string;
  audienceType: DeveloperSpecialAccessAudience;
  roomName: string;
  secret: string;
}): Promise<DeveloperSpecialAccessGrantResult> {
  const initial = await findDeveloperSpecialAccessCode(input.code, input.secret);
  if (!initial) return { status: "not-found" };

  const { firestore } = getFirebaseAdmin();
  const ref = firestore.collection(COLLECTION).doc(initial.id);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const record = parseRecord(snapshot.id, snapshot.data());
    if (!snapshot.exists || !record || !matchesSpecialAccessCode(input.code, record.codeHash, input.secret)) {
      return { status: "denied", message: "That developer special-access code is no longer available." };
    }
    if (!record.enabled) return { status: "denied", message: "That developer special-access code is turned off." };

    const current = record.redeemedBy;
    if (current && current.uid !== input.uid) {
      return { status: "denied", message: "That code is already assigned to another account." };
    }
    if (record.mode === "temporal" && current && current.roomName !== input.roomName) {
      return { status: "denied", message: "That one-time code was already used for another service." };
    }

    const identity = current?.identity ?? ("viewer-" + input.uid + "-developer-" + record.id.slice(0, 8));
    const redeemedBy: DeveloperSpecialAccessRedeemedBy = {
      uid: input.uid,
      name: current?.name ?? input.name,
      audienceType: current?.audienceType ?? input.audienceType,
      identity,
      firstConnectedAt: current?.firstConnectedAt ?? "",
      lastConnectedAt: current?.lastConnectedAt ?? "",
      ...(current?.lastDisconnectedAt ? { lastDisconnectedAt: current.lastDisconnectedAt } : {}),
      lastRoomName: input.roomName,
      ...(record.mode === "temporal" ? { roomName: input.roomName } : {}),
    };
    transaction.update(ref, { redeemedBy });
    return { status: "granted", record: { ...record, redeemedBy }, identity };
  });
}

export async function recordDeveloperSpecialAccessConnection(input: {
  codeId: string;
  identity: string;
  roomName: string;
  event: "connected" | "disconnected";
}): Promise<void> {
  const ref = getFirebaseAdmin().firestore.collection(COLLECTION).doc(input.codeId);
  await getFirebaseAdmin().firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const record = parseRecord(snapshot.id, snapshot.data());
    const redeemedBy = record?.redeemedBy;
    if (
      !record || !redeemedBy || redeemedBy.identity !== input.identity ||
      (input.event === "disconnected" && redeemedBy.lastRoomName !== input.roomName) ||
      (input.event === "connected" && record.mode === "temporal" && redeemedBy.roomName !== input.roomName)
    ) return;

    const now = new Date().toISOString();
    const nextRedeemedBy: DeveloperSpecialAccessRedeemedBy = input.event === "connected"
      ? { ...redeemedBy, firstConnectedAt: redeemedBy.firstConnectedAt || now, lastConnectedAt: now, lastRoomName: input.roomName }
      : { ...redeemedBy, lastDisconnectedAt: now };
    transaction.update(ref, { redeemedBy: nextRedeemedBy });
  });
}

export async function getDeveloperSpecialAccessGrant(
  uid: string,
  roomName: string,
): Promise<{ record: DeveloperSpecialAccessRecord; identity: string } | null> {
  const snapshot = await getFirebaseAdmin().firestore.collection(COLLECTION)
    .where("redeemedBy.uid", "==", uid)
    .get();
  const records = snapshot.docs.flatMap((document) => {
    const record = parseRecord(document.id, document.data());
    return record ? [record] : [];
  });
  const record = records.find((item) =>
    item.enabled &&
    item.redeemedBy?.uid === uid &&
    (item.mode === "permanent" || item.redeemedBy.roomName === roomName),
  );
  return record?.redeemedBy ? { record, identity: record.redeemedBy.identity } : null;
}

export function developerSpecialAccessCodeHash(code: string, secret: string): string {
  return hashSpecialAccessCode(code, secret);
}

export function developerSpecialAccessCollectionName(): string {
  return COLLECTION;
}
