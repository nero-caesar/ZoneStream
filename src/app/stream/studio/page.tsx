import StreamStudio from "../../../components/stream/stream-studio/StreamStudio";
import { getCurrentAccount } from "../../../lib/auth/session";
import { redirect } from "next/navigation";

export default async function StreamStudioRoute() {
  const account = await getCurrentAccount();
  if (!account) redirect("/login-page-zonal");
  if (account.profile.role !== "zonal") redirect("/dashboard");
  return <StreamStudio zonalName={account.profile.displayName} />;
}
