import { NextRequest, NextResponse } from "next/server";
import { getRequestAccount, isSameOriginRequest } from "../../../../lib/auth/server";
import { getFirebaseAdmin } from "../../../../lib/firebase/admin";
import { getFirebaseInstallationDocumentId, isValidFirebaseInstallationId } from "../../../../lib/notifications/fid";

export const runtime = "nodejs";

async function getIndividualAccount(request: NextRequest) {
  const account = await getRequestAccount(request);
  return account?.profile.role === "individual" ? account : null;
}

export async function GET(request: NextRequest) {
  const account = await getIndividualAccount(request);
  if (!account) return NextResponse.json({ enabled: false }, { status: 401 });
  const fid = request.nextUrl.searchParams.get("fid");
  if (!isValidFirebaseInstallationId(fid)) return NextResponse.json({ enabled: false });

  try {
    const { firestore } = getFirebaseAdmin();
    const device = await firestore.collection("notificationDevices").doc(getFirebaseInstallationDocumentId(fid)).get();
    return NextResponse.json({ enabled: device.exists && device.get("uid") === account.profile.uid && device.get("active") === true });
  } catch {
    return NextResponse.json({ enabled: false });
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please enable notifications on ZoneStream." }, { status: 403 });
  const account = await getIndividualAccount(request);
  if (!account) return NextResponse.json({ error: "Only individual accounts can enable viewer notifications." }, { status: 403 });

  let body: { fid?: unknown };
  try {
    body = await request.json() as { fid?: unknown };
  } catch {
    return NextResponse.json({ error: "The notification device could not be registered." }, { status: 400 });
  }
  if (!isValidFirebaseInstallationId(body.fid)) {
    return NextResponse.json({ error: "ZoneStream could not identify this device. Please try again." }, { status: 400 });
  }

  try {
    const { firestore } = getFirebaseAdmin();
    await firestore.collection("notificationDevices").doc(getFirebaseInstallationDocumentId(body.fid)).set({
      fid: body.fid,
      uid: account.profile.uid,
      role: "individual",
      active: true,
      updatedAt: new Date(),
    });
    return NextResponse.json({ enabled: true });
  } catch {
    return NextResponse.json({ error: "We could not save this notification device. Please try again." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Please change notification settings on ZoneStream." }, { status: 403 });
  const account = await getIndividualAccount(request);
  if (!account) return NextResponse.json({ disabled: true });

  let body: { fid?: unknown };
  try {
    body = await request.json() as { fid?: unknown };
  } catch {
    return NextResponse.json({ error: "The notification device could not be removed." }, { status: 400 });
  }
  if (!isValidFirebaseInstallationId(body.fid)) return NextResponse.json({ disabled: true });

  try {
    const { firestore } = getFirebaseAdmin();
    const reference = firestore.collection("notificationDevices").doc(getFirebaseInstallationDocumentId(body.fid));
    const device = await reference.get();
    if (device.exists && device.get("uid") === account.profile.uid) await reference.delete();
    return NextResponse.json({ disabled: true });
  } catch {
    return NextResponse.json({ error: "We could not remove this notification device. Please try again." }, { status: 503 });
  }
}
