import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest, verifyIdToken } from "../../../../lib/auth/server";
import type { AccountProfile } from "../../../../lib/auth/types";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { recordPlatformActivity } from "../../../../lib/audit/platform-activity";

export const runtime = "nodejs";

type SignupRequest = { idToken?: unknown; role?: unknown; displayName?: unknown };

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Please create your account from the ZoneStream website." }, { status: 403 });
  }

  let body: SignupRequest;
  try {
    body = await request.json() as SignupRequest;
  } catch {
    return NextResponse.json({ error: "Please send a valid account request." }, { status: 400 });
  }

  if (body.role !== "individual") {
    return NextResponse.json({ error: "Only individuals can create their own accounts. Churches are registered by the Zonal Church." }, { status: 403 });
  }

  let claims: Awaited<ReturnType<typeof verifyIdToken>>;
  try {
    claims = await verifyIdToken(body.idToken);
  } catch (error) {
    const details = error && typeof error === "object"
      ? error as { name?: unknown; code?: unknown }
      : null;
    console.error("[ZoneStream auth] Sign-up token verifier unavailable", {
      name: typeof details?.name === "string" ? details.name : typeof error,
      code: typeof details?.code === "string" ? details.code : undefined,
    });
    return NextResponse.json({ error: "We couldn't verify your sign-up right now. Please try again later." }, { status: 503 });
  }
  if (!claims || typeof body.idToken !== "string" || !claims.email) {
    return NextResponse.json({ error: "Your sign-up has expired. Please create the account again." }, { status: 401 });
  }

  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 80) : "";
  if (displayName.length < 2) {
    return NextResponse.json({ error: "Enter your full name to create an account." }, { status: 400 });
  }

  try {
    const { firestore } = getFirebaseAdmin();
    const accountRef = firestore.collection("accounts").doc(claims.uid);
    const existing = await accountRef.get();
    if (existing.exists) {
      const profile = existing.data() as Omit<AccountProfile, "uid">;
      if (profile.role !== "individual") {
        return NextResponse.json({ error: "This account is already registered for another portal." }, { status: 409 });
      }
      return NextResponse.json({ profile: { uid: claims.uid, ...profile } });
    }

    const profile: AccountProfile = {
      uid: claims.uid,
      role: "individual",
      status: "active",
      displayName,
      email: claims.email,
      createdAt: new Date().toISOString(),
    };
    await accountRef.create(profile);
    await recordPlatformActivity({ action: "individual_registered", label: `${displayName} created an individual account`, actorType: "individual", actorName: displayName, subjectId: claims.uid });
    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    const details = error && typeof error === "object"
      ? error as { name?: unknown; code?: unknown }
      : null;
    console.error("[ZoneStream auth] Account registration failed", {
      name: typeof details?.name === "string" ? details.name : typeof error,
      code: typeof details?.code === "string" ? details.code : undefined,
    });
    return NextResponse.json({ error: "We could not finish creating your account. Please try again." }, { status: 503 });
  }
}
