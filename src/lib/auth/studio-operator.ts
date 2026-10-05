import "server-only";

import type { NextRequest } from "next/server";
import { requireZonalAccount } from "./server";
import { verifyDeveloperRequest } from "./developer-space";

export type StudioOperator = {
  kind: "zonal" | "developer";
  uid: string;
  displayName: string;
};

export async function getStudioOperator(request: NextRequest): Promise<StudioOperator | null> {
  const zonal = await requireZonalAccount(request);
  if (zonal) {
    return { kind: "zonal", uid: zonal.profile.uid, displayName: zonal.profile.displayName };
  }

  if (await verifyDeveloperRequest(request)) {
    return { kind: "developer", uid: "developer-owner", displayName: "ZoneStream Developer" };
  }

  return null;
}
