import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { hashChurchCode } from "../../../../lib/auth/church-codes";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";

export const runtime = "nodejs";

const loginAttempts = new Map<string, { count: number; resetsAt: number }>();
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function overLoginLimit(request: NextRequest): boolean {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip") || "unknown-client";
  const key = createHash("sha256").update(address).digest("hex");
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetsAt <= now) {
    loginAttempts.set(key, { count: 1, resetsAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  current.count += 1;
  return current.count > LOGIN_ATTEMPT_LIMIT;
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Please sign in from the ZoneStream website." }, { status: 403 });
  }

  let body: { code?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter your church access code." }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^\d{10}$/.test(code)) {
    return NextResponse.json({ error: "Enter the 10-digit code given to your church." }, { status: 400 });
  }
  if (overLoginLimit(request)) {
    return NextResponse.json({ error: "Too many church code attempts. Wait 15 minutes before trying again." }, { status: 429 });
  }

  try {
    const { auth, firestore } = getFirebaseAdmin();
    const codeSnapshot = await firestore.collection("churchCodes").doc(hashChurchCode(code)).get();
    const uid = codeSnapshot.data()?.uid;
    if (!codeSnapshot.exists || typeof uid !== "string") {
      return NextResponse.json({ error: "That church code was not found. Check the code with the Zonal Church." }, { status: 401 });
    }
    const accountSnapshot = await firestore.collection("accounts").doc(uid).get();
    const account = accountSnapshot.data();
    if (!accountSnapshot.exists || account?.role !== "church" || account.status !== "active") {
      return NextResponse.json({ error: "This church account is not active. Contact the Zonal Church." }, { status: 403 });
    }

    const customToken = await auth.createCustomToken(uid);
    await recordPlatformActivity({ action: "church_signed_in", label: `${String(account.churchName ?? account.displayName ?? "Church")} signed in`, actorType: "church", actorName: String(account.churchName ?? account.displayName ?? "Church"), subjectId: uid });
    return NextResponse.json({ customToken, churchName: account.churchName });
  } catch {
    return NextResponse.json({ error: "ZoneStream could not sign in to this church right now. Please try again." }, { status: 503 });
  }
}
