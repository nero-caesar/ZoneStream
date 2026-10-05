import DeveloperSpace from "../../components/developer-space/DeveloperSpace";
import { getDeveloperCredentials, getDeveloperPageSession } from "../../lib/auth/developer-space";

export const dynamic = "force-dynamic";

export default async function DeveloperPage() {
  let mode: "setup" | "login" | "dashboard" | "unavailable" = "unavailable";
  try {
    const credentials = await getDeveloperCredentials();
    mode = !credentials ? "setup" : await getDeveloperPageSession() ? "dashboard" : "login";
  } catch {
    mode = "unavailable";
  }
  return <DeveloperSpace initialMode={mode} />;
}
