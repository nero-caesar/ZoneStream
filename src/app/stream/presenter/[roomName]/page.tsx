import { redirect } from "next/navigation";
import RemotePresenter, { PresenterLoginChoice } from "../../../../components/stream/remote-presenter/RemotePresenter";
import { getCurrentAccount } from "../../../../lib/auth/session";

type PresenterPageProps = {
  params: Promise<{ roomName: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function RemotePresenterPage({ params, searchParams }: PresenterPageProps) {
  const [{ roomName }, query] = await Promise.all([params, searchParams]);
  const inviteToken = typeof query.invite === "string" ? query.invite : "";
  const title = typeof query.title === "string" && query.title.trim() ? query.title.trim() : "the live service";
  if (!/^[a-z0-9][a-z0-9-]{5,79}$/i.test(roomName) || inviteToken.length < 32 || inviteToken.length > 128) redirect("/dashboard");

  const nextPath = `/stream/presenter/${encodeURIComponent(roomName)}?invite=${encodeURIComponent(inviteToken)}&title=${encodeURIComponent(title)}`;
  const account = await getCurrentAccount();
  if (account?.profile.role === "zonal") redirect("/stream/studio");
  if (!account) return <PresenterLoginChoice nextPath={nextPath} title={title} />;

  return <RemotePresenter roomName={roomName} inviteToken={inviteToken} title={title} presenterName={account.profile.displayName} />;
}
