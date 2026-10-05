import type { Portal, FormMode } from "../types";
import MarketingPanel from "../marketing-panel/MarketingPanel";
import AccountForm from "../account-form/AccountForm";
import "./auth-page.css";

export default function AuthPage({ portal, mode }: { portal: Portal; mode: FormMode }) {
  const portalLabel = portal === "church" ? "Church" : portal === "zonal" ? "Zonal Church" : "Individual";
  return (
    <main className={`auth-layout auth-${portal}`}>
      <MarketingPanel portal={portal} />
      <section className="auth-panel" aria-label={`${portalLabel} account access`}>
        <AccountForm portal={portal} mode={mode} />
      </section>
    </main>
  );
}
