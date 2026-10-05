import { randomUUID } from "node:crypto";
import { RoomServiceClient } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { getStudioOperator } from "../../../../lib/auth/studio-operator";
import { decryptChurchCode, encryptChurchCode, generateChurchCode, hashChurchCode } from "../../../../lib/auth/church-codes";
import type { AccountProfile } from "../../../../lib/auth/types";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";
import { disconnectRoomParticipants } from "../../../../lib/stream/disconnect-participants";
import { parseStreamAccessPolicy } from "../../../../lib/stream/access-policy";
import { hashChurchAccessKey } from "../../../../lib/stream/special-access-crypto";

export const runtime = "nodejs";

function cleanText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function churchNameKey(name: string, location: string): string {
  const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${normalize(name)}--${normalize(location)}`;
}

export async function GET(request: NextRequest) {
  if (!await getStudioOperator(request)) return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to manage church accounts." }, { status: 403 });

  try {
    const { firestore } = getFirebaseAdmin();
    const snapshot = await firestore.collection("accounts").where("role", "==", "church").get();
    const connectedChurches = new Map<string, string>();
    let allowedChurchKeys: Set<string> | null = null;
    let liveAccessStatusKnown = false;
    try {
      let roomName = request.nextUrl.searchParams.get("roomName");
      if (!roomName) {
        const currentProgram = await firestore.collection("programs").doc("current").get();
        const savedRoomName = currentProgram.get("roomName");
        if (typeof savedRoomName === "string") roomName = savedRoomName;
      }
      const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
      if (!roomName) {
        liveAccessStatusKnown = true;
      } else if (/^[a-z0-9][a-z0-9-]{5,79}$/i.test(roomName) && LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
        const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
        const [activeRoom] = await roomService.listRooms([roomName]);
        if (activeRoom) {
          const policy = parseStreamAccessPolicy(activeRoom.metadata);
          allowedChurchKeys = new Set(policy.blockedChurchAccessKeys);
        }
        const participants = await roomService.listParticipants(roomName);
        for (const participant of participants) {
          try {
            const metadata = JSON.parse(participant.metadata || "{}") as { audienceType?: unknown; accountUid?: unknown };
            if (metadata.audienceType !== "church" || typeof metadata.accountUid !== "string") continue;
            const joinedAtMs = Number(participant.joinedAtMs || participant.joinedAt * BigInt(1000));
            connectedChurches.set(metadata.accountUid, new Date(joinedAtMs).toISOString());
          } catch {
            // Ignore participants that do not carry church account metadata.
          }
        }
        liveAccessStatusKnown = true;
      }
    } catch (error) {
      const diagnostic = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : {};
      console.error("[zonal/churches] LiveKit status unavailable", {
        name: typeof diagnostic.name === "string" ? diagnostic.name : "Error",
        code: typeof diagnostic.code === "string" ? diagnostic.code : undefined,
      });
    }

    const churches = snapshot.docs.map((document) => {
      const account = document.data() as Omit<AccountProfile, "uid">;
      const connectedAt = connectedChurches.get(document.id);
      return {
        uid: document.id,
        churchName: account.churchName ?? account.displayName,
        churchLocation: account.churchLocation ?? "",
        churchType: account.churchType ?? "local",
        phone: account.phone ?? "",
        code: account.churchCodeEncrypted ? decryptChurchCode(account.churchCodeEncrypted) : null,
        status: account.status,
        connected: Boolean(connectedAt),
        connectedAt: connectedAt ?? null,
        accessEnabled: allowedChurchKeys === null || !allowedChurchKeys.has(hashChurchAccessKey(document.id, process.env.LIVEKIT_API_SECRET ?? "")),
        liveAccessStatusKnown,
        createdAt: account.createdAt ?? "",
      };
    }).sort((left, right) => left.churchName.localeCompare(right.churchName));
    return NextResponse.json({ churches });
  } catch (error) {
    const diagnostic = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : {};
    console.error("[zonal/churches] directory load failed", {
      name: typeof diagnostic.name === "string" ? diagnostic.name : "Error",
      code: typeof diagnostic.code === "string" ? diagnostic.code : undefined,
    });
    return NextResponse.json({ error: "We could not load the registered churches." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please use ZoneStream to create church accounts." }, { status: 403 });
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to create church accounts." }, { status: 403 });

  let body: { churchName?: unknown; churchLocation?: unknown; churchType?: unknown; phone?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please enter the church details." }, { status: 400 });
  }

  const churchName = cleanText(body.churchName, 100);
  const churchLocation = cleanText(body.churchLocation, 120);
  const churchType = body.churchType === "group" ? "group" : body.churchType === "local" ? "local" : "";
  const phone = cleanText(body.phone, 32);
  if (churchName.length < 2 || churchLocation.length < 2 || !churchType) {
    return NextResponse.json({ error: "Enter the church name, location, and church type." }, { status: 400 });
  }

  const normalizedName = churchNameKey(churchName, churchLocation);
  if (normalizedName === "--") return NextResponse.json({ error: "Enter valid church details." }, { status: 400 });

  const uid = randomUUID();
  let createdUser = false;
  let adminAuth: ReturnType<typeof getFirebaseAdmin>["auth"] | null = null;
  try {
    const { auth, firestore } = getFirebaseAdmin();
    adminAuth = auth;

    // Catch duplicates from accounts created before the unique-name index existed.
    const existingChurches = await firestore.collection("accounts").where("role", "==", "church").get();
    const duplicateChurch = existingChurches.docs.some((document) => {
      const account = document.data();
      const existingName = typeof account.churchName === "string" ? account.churchName : String(account.displayName ?? "");
      const existingLocation = typeof account.churchLocation === "string" ? account.churchLocation : "";
      return churchNameKey(existingName, existingLocation) === normalizedName;
    });
    if (duplicateChurch) {
      return NextResponse.json({ error: "A church with this name and location is already registered." }, { status: 409 });
    }

    await auth.createUser({ uid, displayName: churchName, disabled: false });
    createdUser = true;

    const accountRef = firestore.collection("accounts").doc(uid);
    const nameRef = firestore.collection("churchNameIndex").doc(normalizedName);
    let code = "";
    let account: AccountProfile | undefined;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      code = generateChurchCode();
      const codeHash = hashChurchCode(code);
      const codeRef = firestore.collection("churchCodes").doc(codeHash);
      const candidate: AccountProfile = {
        uid,
        role: "church",
        status: "active",
        displayName: churchName,
        churchName,
        churchLocation,
        churchType,
        churchCodeHash: codeHash,
        churchCodeEncrypted: encryptChurchCode(code),
        ...(phone ? { phone } : {}),
        createdAt: new Date().toISOString(),
      };

      try {
        account = await firestore.runTransaction(async (transaction) => {
          const [accountSnapshot, nameSnapshot, codeSnapshot] = await Promise.all([
            transaction.get(accountRef), transaction.get(nameRef), transaction.get(codeRef),
          ]);
          if (accountSnapshot.exists) throw new Error("ACCOUNT_COLLISION");
          if (nameSnapshot.exists) throw new Error("CHURCH_ALREADY_REGISTERED");
          if (codeSnapshot.exists) throw new Error("CODE_COLLISION");
          transaction.create(accountRef, candidate);
          transaction.create(nameRef, { uid, churchName, churchLocation, churchType });
          transaction.create(codeRef, { uid, createdAt: candidate.createdAt });
          return candidate;
        });
        break;
      } catch (error) {
        if (error instanceof Error && error.message === "CODE_COLLISION") continue;
        if (error instanceof Error && error.message === "CHURCH_ALREADY_REGISTERED") {
          await auth.deleteUser(uid).catch(() => undefined);
          createdUser = false;
          return NextResponse.json({ error: "A church with this name and location is already registered." }, { status: 409 });
        }
        throw error;
      }
    }

    if (!account) throw new Error("CODE_RETRY_LIMIT");
    await recordPlatformActivity({ action: "church_registered", label: `${operator.displayName} registered ${churchName}`, actorType: operator.kind, actorName: operator.displayName, subjectName: churchName, subjectId: uid });
    return NextResponse.json({
      church: {
        uid,
        churchName,
        churchLocation,
        churchType,
        phone,
        code,
        status: account.status,
        createdAt: account.createdAt,
      },
    }, { status: 201 });
  } catch (error) {
    if (createdUser) await adminAuth?.deleteUser(uid).catch(() => undefined);
    const message = error instanceof Error && error.message === "CODE_RETRY_LIMIT"
      ? "We could not issue a unique church code. Please try again."
      : "We could not create the church account right now. Please try again.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please manage church accounts from ZoneStream." }, { status: 403 });
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to manage church accounts." }, { status: 403 });

  let body: { uid?: unknown; action?: unknown };
  try {
    body = await request.json() as { uid?: unknown; action?: unknown };
  } catch {
    return NextResponse.json({ error: "Choose a church and an access action." }, { status: 400 });
  }
  const uid = typeof body.uid === "string" ? body.uid : "";
  const action = body.action === "suspend" || body.action === "resume" ? body.action : "";
  if (!/^[a-f0-9-]{36}$/i.test(uid) || !action) return NextResponse.json({ error: "Choose a valid church access action." }, { status: 400 });

  try {
    const { auth, firestore } = getFirebaseAdmin();
    const accountRef = firestore.collection("accounts").doc(uid);
    const accountSnapshot = await accountRef.get();
    const account = accountSnapshot.data();
    if (!accountSnapshot.exists || account?.role !== "church") return NextResponse.json({ error: "That registered church was not found." }, { status: 404 });
    const churchName = typeof account.churchName === "string" ? account.churchName : String(account.displayName ?? "Church");
    const nextStatus = action === "suspend" ? "suspended" : "active";
    let warning: string | undefined;
    if (account.status === nextStatus) return NextResponse.json({ status: nextStatus, alreadySet: true });

    if (action === "suspend") {
      await accountRef.update({ status: nextStatus, accessChangedAt: new Date().toISOString() });
      await auth.updateUser(uid, { disabled: true }).catch(() => {
        warning = "Church access is halted. Its account service could not be updated, but ZoneStream sign-in and streaming access are blocked.";
      });
    } else {
      await auth.updateUser(uid, { disabled: false });
      await accountRef.update({ status: nextStatus, accessChangedAt: new Date().toISOString() });
    }

    if (action === "suspend") {
      const program = (await firestore.collection("programs").doc("current").get()).data();
      const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
      if (program && typeof program.roomName === "string" && LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
        try {
          const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
          const disconnected = await disconnectRoomParticipants(roomService, program.roomName, (participant) => {
            if (!participant.identity.startsWith("viewer-")) return false;
            try {
              const metadata = JSON.parse(participant.metadata ?? "{}") as { accountUid?: unknown; audienceType?: unknown };
              return metadata.accountUid === uid && metadata.audienceType === "church";
            } catch {
              return false;
            }
          });
          if (disconnected.remainingCount > 0) warning = "Church access is halted. A current connection could not be removed yet; try halting access again.";
        } catch {
          warning = "Church access is halted for new sign-ins. We could not remove its current stream connection yet.";
        }
      } else if (program && typeof program.roomName === "string") {
        warning = "Church access is halted for new sign-ins. The live room could not be reached to remove its current connection.";
      }
    }

    const label = action === "suspend" ? `${operator.displayName} halted ${churchName}'s platform access` : `${operator.displayName} restored ${churchName}'s platform access`;
    await recordPlatformActivity({ action: action === "suspend" ? "church_access_halted" : "church_access_restored", label, actorType: operator.kind, actorName: operator.displayName, subjectName: churchName, subjectId: uid });
    return NextResponse.json({ status: nextStatus, ...(warning ? { warning } : {}) });
  } catch {
    return NextResponse.json({ error: "The church access setting could not be changed. Please try again." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please manage church accounts from ZoneStream." }, { status: 403 });
  const operator = await getStudioOperator(request);
  if (!operator) return NextResponse.json({ error: "Sign in to the Zonal Studio or Developer Space to delete church accounts." }, { status: 403 });

  const uid = request.nextUrl.searchParams.get("uid") ?? "";
  if (!/^[a-f0-9-]{36}$/i.test(uid)) return NextResponse.json({ error: "Choose a valid church account." }, { status: 400 });

  try {
    const { auth, firestore } = getFirebaseAdmin();
    const accountRef = firestore.collection("accounts").doc(uid);
    const accountSnapshot = await accountRef.get();
    const account = accountSnapshot.data();
    if (!accountSnapshot.exists || account?.role !== "church") return NextResponse.json({ error: "That registered church was not found." }, { status: 404 });
    const churchName = typeof account.churchName === "string" ? account.churchName : String(account.displayName ?? "Church");

    await accountRef.update({ status: "suspended", deletionPending: true, accessChangedAt: new Date().toISOString() });
    await auth.updateUser(uid, { disabled: true }).catch(() => undefined);

    const program = (await firestore.collection("programs").doc("current").get()).data();
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
    let warning: string | undefined;
    if (program && typeof program.roomName === "string" && LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
      try {
        const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
        const disconnected = await disconnectRoomParticipants(roomService, program.roomName, (participant) => {
          try {
            const metadata = JSON.parse(participant.metadata ?? "{}") as { accountUid?: unknown; audienceType?: unknown };
            return participant.identity.startsWith("viewer-") && metadata.accountUid === uid && metadata.audienceType === "church";
          } catch {
            return false;
          }
        });
        if (disconnected.remainingCount) warning = "The account was deleted, but its current live connection could not be removed yet.";
      } catch {
        warning = "The account was deleted, but its current live connection could not be removed yet.";
      }
    } else if (program && typeof program.roomName === "string") {
      warning = "The account was deleted, but its current live connection could not be reached to remove it.";
    }

    const batch = firestore.batch();
    batch.delete(accountRef);
    if (typeof account.churchCodeHash === "string") batch.delete(firestore.collection("churchCodes").doc(account.churchCodeHash));
    const [nameEntries, codeEntries] = await Promise.all([
      firestore.collection("churchNameIndex").where("uid", "==", uid).get(),
      firestore.collection("churchCodes").where("uid", "==", uid).get(),
    ]);
    nameEntries.docs.forEach((document) => batch.delete(document.ref));
    codeEntries.docs.forEach((document) => batch.delete(document.ref));
    await auth.deleteUser(uid).catch((error: unknown) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "auth/user-not-found")) throw error;
    });
    await batch.commit();
    await recordPlatformActivity({ action: "church_deleted", label: `${operator.displayName} deleted ${churchName}`, actorType: operator.kind, actorName: operator.displayName, subjectName: churchName, subjectId: uid });
    return NextResponse.json({ deleted: true, ...(warning ? { warning } : {}) });
  } catch {
    return NextResponse.json({ error: "The church account could not be deleted. Its access may already be halted; please refresh and try again." }, { status: 503 });
  }
}
