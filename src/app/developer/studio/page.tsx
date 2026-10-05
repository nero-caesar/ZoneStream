import { redirect } from "next/navigation";
import StreamStudio from "../../../components/stream/stream-studio/StreamStudio";
import { getDeveloperPageSession } from "../../../lib/auth/developer-space";

export const dynamic = "force-dynamic";

export default async function DeveloperStudioPage() {
  if (!await getDeveloperPageSession()) redirect("/developer/developer-space");
  return <StreamStudio zonalName="ZoneStream Developer" developerMode />;
}
