import WatchPage from "../../../../components/stream/watch-page/WatchPage";

type WatchPageProps = {
  params: Promise<{ roomName: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function StreamWatchRoute({ params, searchParams }: WatchPageProps) {
  const [{ roomName }, { title }] = await Promise.all([params, searchParams]);
  const pageTitle = typeof title === "string" ? title.trim() : "";
  return <WatchPage roomName={roomName} title={pageTitle || "Zonal Church Live Service"} />;
}
