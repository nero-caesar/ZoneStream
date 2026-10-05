import { redirect } from "next/navigation";
import AccountDashboard from "../../components/account-dashboard/AccountDashboard";
import { getCurrentAccount } from "../../lib/auth/session";
import { toPublicAccountProfile } from "../../lib/auth/public-profile";

export default async function DashboardPage() {
  const account = await getCurrentAccount();
  if (!account) redirect("/login-page-individual");
  if (account.profile.role === "zonal") redirect("/stream/studio");
  return <AccountDashboard profile={toPublicAccountProfile(account.profile)} />;
}
