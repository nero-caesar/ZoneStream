import { redirect } from "next/navigation";
import ZonalChurches from "../../../components/zonal-churches/ZonalChurches";
import { getDeveloperPageSession } from "../../../lib/auth/developer-space";

export const dynamic = "force-dynamic";

export default async function DeveloperChurchesPage() {
  if (!await getDeveloperPageSession()) redirect("/developer/developer-space");
  return <ZonalChurches developerMode />;
}
