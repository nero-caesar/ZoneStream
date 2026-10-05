import WatchPage from "../../../../components/stream/watch-page/WatchPage";
import { getCurrentAccount } from "../../../../lib/auth/session";
import { redirect } from "next/navigation";
import { toPublicAccountProfile } from "../../../../lib/auth/public-profile";
import { getDeveloperPageSession } from "../../../../lib/auth/developer-space";

type WatchPageProps = {
  params: Promise<{ roomName: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function StreamWatchRoute({ params, searchParams }: WatchPageProps) {
  const [{ roomName }, { title, developerPreview: previewParam }] = await Promise.all([params, searchParams]);
  const developerPreview = previewParam === "1" && await getDeveloperPageSession();
  const account = developerPreview ? null : await getCurrentAccount();
  if (!account && !developerPreview) redirect("/login-page-individual");
  if (account?.profile.role === "zonal") redirect("/stream/studio");
  const pageTitle = typeof title === "string" ? title.trim() : "";
  return <WatchPage roomName={roomName} title={pageTitle || "Zonal Church Live Service"} profile={account ? toPublicAccountProfile(account.profile) : null} developerPreview={developerPreview} />;
}
