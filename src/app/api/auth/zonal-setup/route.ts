import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/server";
import { isLocalZonalSetupRequest, ZONAL_ACCOUNT_UID } from "../../../../lib/auth/zonal-password";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";

export const runtime = "nodejs";

function validPassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 14 && Buffer.byteLength(password, "utf8") <= 128;
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Please set up the Zonal password from ZoneStream." }, { status: 403 });
  }
  if (!isLocalZonalSetupRequest(request)) {
    return NextResponse.json({ error: "Initial setup and manual resets are only available from the local ZoneStream app." }, { status: 403 });
  }

  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please enter a valid password." }, { status: 400 });
  }
  if (!validPassword(body.password)) {
    return NextResponse.json({ error: "Use a password or passphrase with at least 14 characters." }, { status: 400 });
  }

  try {
    const { auth, firestore } = getFirebaseAdmin();
    const accessRef = firestore.collection("zonalAuth").doc("access");
    const accountRef = firestore.collection("accounts").doc(ZONAL_ACCOUNT_UID);
    const currentAccess = await accessRef.get();
    if (currentAccess.exists && currentAccess.get("recoveryEnabled") === true) {
      return NextResponse.json({ error: "Studio password changes need approval in Developer Space." }, { status: 403 });
    }
    let authUser: Awaited<ReturnType<typeof auth.getUser>> | null = null;
    try {
      authUser = await auth.getUser(ZONAL_ACCOUNT_UID);
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
      if (code !== "auth/user-not-found") throw error;
    }

    const zonalAuthEmail = authUser?.email || process.env.ZONAL_AUTH_EMAIL?.trim().toLowerCase();
    if (!zonalAuthEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(zonalAuthEmail)) {
      return NextResponse.json({ error: "The Zonal Studio sign-in email is not configured." }, { status: 503 });
    }

    const authUserData = {
      displayName: "Zonal Church",
      email: zonalAuthEmail,
      password: body.password,
      disabled: false,
    };
    if (authUser) {
      await auth.updateUser(ZONAL_ACCOUNT_UID, authUserData);
    } else {
      await auth.createUser({ uid: ZONAL_ACCOUNT_UID, ...authUserData });
    }

    const profile = {
      uid: ZONAL_ACCOUNT_UID,
      role: "zonal",
      status: "active",
      displayName: "Zonal Church",
      createdAt: new Date().toISOString(),
    };

    await firestore.runTransaction(async (transaction) => {
      const [accessSnapshot, accountSnapshot] = await Promise.all([
        transaction.get(accessRef),
        transaction.get(accountRef),
      ]);
      if (accountSnapshot.exists && accountSnapshot.get("role") !== "zonal") {
        throw new Error("ZONAL_ACCOUNT_ID_IN_USE");
      }
      transaction.set(accessRef, {
        ...(accessSnapshot.data() ?? {}),
        recoveryEnabled: true,
        createdAt: accessSnapshot.get("createdAt") ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      if (!accountSnapshot.exists) transaction.create(accountRef, profile);
    });

    await auth.revokeRefreshTokens(ZONAL_ACCOUNT_UID).catch(() => undefined);
    const customToken = await auth.createCustomToken(ZONAL_ACCOUNT_UID, { role: "zonal" });
    const response = NextResponse.json({ customToken }, { status: 201 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "ZONAL_ACCOUNT_ID_IN_USE") {
      return NextResponse.json({ error: "The Zonal Church account could not be initialized. Please try again later." }, { status: 409 });
    }
    if (typeof error === "object" && error && "code" in error && String(error.code) === "auth/email-already-exists") {
      return NextResponse.json({ error: "Studio setup could not be completed with these details. Please try again." }, { status: 409 });
    }
    return NextResponse.json({ error: "We could not save the studio password right now. Please try again." }, { status: 503 });
  }
}
