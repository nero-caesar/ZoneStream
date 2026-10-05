import { redirect } from "next/navigation";
import ZonalChurches from "../../../components/zonal-churches/ZonalChurches";
import { getCurrentAccount } from "../../../lib/auth/session";
import { getDeveloperPageSession } from "../../../lib/auth/developer-space";

export default async function ZonalChurchesPage() {
  const account = await getCurrentAccount();
  if (account?.profile.role === "zonal") return <ZonalChurches />;
  if (await getDeveloperPageSession()) return <ZonalChurches developerMode />;
  if (!account) redirect("/login-page-zonal");
  redirect("/dashboard");
}
