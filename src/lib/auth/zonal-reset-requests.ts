import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import type { NextRequest } from "next/server";
import { getFirebaseAdmin } from "../firebase/admin";
import { sendEmailJsTemplate } from "../email/emailjs";
import { ZONAL_ACCOUNT_UID } from "./zonal-password";

export const ZONAL_RESET_REQUEST_COOKIE = "zonestream_zonal_reset_request";
export const ZONAL_RESET_REQUEST_LIFETIME_MS = 2 * 60 * 60 * 1000;
const RESET_COOLDOWN_MS = 5 * 60 * 1000;

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseRequesterCookie(value: string | undefined) {
  if (!value) return null;
  const [id, token, ...rest] = value.split(".");
  if (rest.length || !/^[a-f0-9-]{36}$/i.test(id ?? "") || !/^[A-Za-z0-9_-]{40,60}$/.test(token ?? "")) return null;
  return { id, token };
}

export async function createZonalResetRequest() {
  const { firestore } = getFirebaseAdmin();
  const accessRef = firestore.collection("zonalAuth").doc("access");
  const requestRef = firestore.collection("zonalPasswordResetRequests").doc(randomUUID());
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const reservation = await firestore.runTransaction(async (transaction) => {
    const access = await transaction.get(accessRef);
    if (!access.exists || access.get("recoveryEnabled") !== true) return { allowed: false as const, reason: "not-ready" as const };
    const previous = Number(access.get("lastRecoveryRequestAt") ?? 0);
    if (Number.isFinite(previous) && now - previous < RESET_COOLDOWN_MS) {
      return { allowed: false as const, reason: "cooldown" as const, retryAfterSeconds: Math.ceil((RESET_COOLDOWN_MS - (now - previous)) / 1000) };
    }
    transaction.update(accessRef, { lastRecoveryRequestAt: now });
    transaction.create(requestRef, {
      status: "pending",
      requesterTokenHash: hashToken(token),
      createdAt: new Date(now).toISOString(),
      expiresAt: now + ZONAL_RESET_REQUEST_LIFETIME_MS,
    });
    return { allowed: true as const };
  });

  if (!reservation.allowed) {
    return {
      ok: false as const,
      reason: reservation.reason,
      ...(reservation.retryAfterSeconds ? { retryAfterSeconds: reservation.retryAfterSeconds } : {}),
    };
  }
  return { ok: true as const, cookieValue: `${requestRef.id}.${token}` };
}

export async function readZonalResetRequest(request: NextRequest) {
  const requester = parseRequesterCookie(request.cookies.get(ZONAL_RESET_REQUEST_COOKIE)?.value);
  if (!requester) return { status: "none" as const };
  const { firestore } = getFirebaseAdmin();
  const ref = firestore.collection("zonalPasswordResetRequests").doc(requester.id);

  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.get("requesterTokenHash") !== hashToken(requester.token)) return { status: "none" as const };
    if (Number(snapshot.get("expiresAt")) <= Date.now()) {
      transaction.update(ref, { status: "expired", encryptedAccessToken: FieldValue.delete() });
      return { status: "expired" as const };
    }
    const status = snapshot.get("status");
    if (status === "pending") return { status: "pending" as const };
    if (status === "sending") return { status: "pending" as const };
    if (status === "rejected") return { status: "rejected" as const };
    if (status === "token-delivered" || status === "link-delivered") return { status: "delivered" as const };
    return { status: "none" as const };
  });
}

export async function listZonalResetRequests() {
  const { firestore } = getFirebaseAdmin();
  const snapshot = await firestore.collection("zonalPasswordResetRequests").orderBy("createdAt", "desc").limit(25).get();
  const now = Date.now();
  const expiredRequests = snapshot.docs.filter((document) => Number(document.get("expiresAt") ?? 0) <= now && ["pending", "sending"].includes(String(document.get("status"))));
  await Promise.all(expiredRequests.map((document) => document.ref.update({ status: "expired", encryptedAccessToken: FieldValue.delete() }).catch(() => undefined)));
  const stuckSending = snapshot.docs.filter((document) => String(document.get("status")) === "sending" && now - Number(document.get("sendStartedAt") ?? now) > 60_000 && Number(document.get("expiresAt") ?? 0) > now);
  await Promise.all(stuckSending.map((document) => document.ref.update({ status: "pending" }).catch(() => undefined)));
  return snapshot.docs.map((document) => {
    const expiresAt = Number(document.get("expiresAt") ?? 0);
    const savedStatus = String(document.get("status") ?? "unknown");
    const status = expiresAt <= now && ["pending", "sending"].includes(savedStatus) ? "expired" : savedStatus;
    return { id: document.id, status, requestedAt: String(document.get("createdAt") ?? ""), expiresAt };
  });
}

export async function decideZonalResetRequest(requestId: string, approved: boolean) {
  if (!/^[a-f0-9-]{36}$/i.test(requestId)) return { ok: false as const, status: "invalid" as const };
  const { firestore } = getFirebaseAdmin();
  const ref = firestore.collection("zonalPasswordResetRequests").doc(requestId);
  if (!approved) return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return { ok: false as const, status: "missing" as const };
    if (snapshot.get("status") !== "pending") return { ok: false as const, status: "already-decided" as const };
    if (Number(snapshot.get("expiresAt")) <= Date.now()) {
      transaction.update(ref, { status: "expired", decidedAt: new Date().toISOString() });
      return { ok: false as const, status: "expired" as const };
    }
    transaction.update(ref, { status: "rejected", decidedAt: new Date().toISOString() });
    return { ok: true as const, status: "rejected" as const };
  });

  const reserved = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return { ok: false as const, status: "missing" as const };
    if (snapshot.get("status") !== "pending") return { ok: false as const, status: "already-decided" as const };
    if (Number(snapshot.get("expiresAt")) <= Date.now()) {
      transaction.update(ref, { status: "expired", decidedAt: new Date().toISOString() });
      return { ok: false as const, status: "expired" as const };
    }
    transaction.update(ref, { status: "sending", decidedAt: new Date().toISOString(), sendStartedAt: Date.now() });
    return { ok: true as const, status: "sending" as const };
  });
  if (!reserved.ok) return reserved;

  try {
    const { auth } = getFirebaseAdmin();
    const zonalUser = await auth.getUser(ZONAL_ACCOUNT_UID);
    if (!zonalUser.email) throw new Error("The Zonal Studio sign-in email is not available.");
    const recoveryEmail = process.env.ZONAL_RECOVERY_EMAIL?.trim().toLowerCase();
    if (!recoveryEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail)) {
      throw new Error("The studio recovery email is not configured.");
    }
    const resetLink = await auth.generatePasswordResetLink(zonalUser.email);
    await sendEmailJsTemplate({ toEmail: recoveryEmail, appName: "ZoneStream", resetLink });
    const current = await ref.get();
    if (!current.exists || current.get("status") !== "sending") return { ok: false as const, status: "already-decided" as const };
    if (Number(current.get("expiresAt")) <= Date.now()) {
      await ref.update({ status: "expired", encryptedAccessToken: FieldValue.delete() });
      return { ok: false as const, status: "expired" as const };
    }
    await ref.update({ status: "link-delivered", deliveredAt: new Date().toISOString(), encryptedAccessToken: FieldValue.delete() });
    return { ok: true as const, status: "link-delivered" as const };
  } catch (error) {
    await ref.update({ status: "pending", lastSendFailedAt: new Date().toISOString(), encryptedAccessToken: FieldValue.delete() }).catch(() => undefined);
    return {
      ok: false as const,
      status: "delivery-failed" as const,
      message: error instanceof Error ? error.message : "EmailJS could not send the studio reset link.",
    };
  }
}
