import { NextRequest, NextResponse } from "next/server";
import { refreshAuthActivity, getRequestAccount, isSameOriginRequest, requireZonalAccount } from "../../../../lib/auth/server";
import { ZONAL_ACCOUNT_UID } from "../../../../lib/auth/zonal-password";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "This request could not be completed." }, { status: 403 });
  const account = await getRequestAccount(request);
  if (!account) return NextResponse.json({ authenticated: false }, { status: 401 });
  if (account.profile.role === "zonal" && (account.profile.uid !== ZONAL_ACCOUNT_UID || !await requireZonalAccount(request))) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return refreshAuthActivity(request) ?? NextResponse.json({ authenticated: false }, { status: 401 });
}
