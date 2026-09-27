import type { Portal, FormMode } from "../types";
import MarketingPanel from "../marketing-panel/MarketingPanel";
import AccountForm from "../account-form/AccountForm";
import "./auth-page.css";

export default function AuthPage({ portal, mode }: { portal: Portal; mode: FormMode }) {
  return (
    <main className={`auth-layout ${portal === "church" ? "auth-church" : "auth-individual"}`}>
      <MarketingPanel portal={portal} />
      <section className="auth-panel" aria-label={`${portal === "church" ? "Church" : "Individual"} account access`}>
        <AccountForm portal={portal} mode={mode} />
      </section>
    </main>
  );
}
