"use client";

import { useState } from "react";
import { FiCheckCircle, FiShield } from "react-icons/fi";
import "./zonal-password-recovery.css";

export default function ZonalPasswordRecovery({ context }: { context: "login" | "studio" }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [sent, setSent] = useState(false);

  async function requestPasswordChange() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/auth/zonal-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const responseText = await response.text();
      let result: { message?: string; error?: string } = {};
      if (responseText.trim()) {
        try {
          result = JSON.parse(responseText) as { message?: string; error?: string };
        } catch {
          // A proxy or server failure can return an HTML error page instead of JSON.
        }
      }
      if (!response.ok) throw new Error(result.error || "We couldn’t send the reset link right now. Please try again.");
      if (!result.message) throw new Error("We couldn’t confirm that the reset link was sent. Please check your inbox before trying again.");
      setSent(true);
      setNotice({ text: result.message });
    } catch (error) {
      const message = error instanceof Error && !/json|unexpected token|failed to execute|response/i.test(error.message)
        ? error.message
        : "We couldn’t send the reset link right now. Please try again.";
      setNotice({ text: message, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`zonal-recovery zonal-recovery-${context}`}>
      <button className="zonal-recovery-button" type="button" onClick={() => void requestPasswordChange()} disabled={busy}>
        <FiShield aria-hidden="true" />
        {busy ? "Sending reset link…" : sent ? "Send another reset link" : context === "login" ? "Forgot the studio password? Email me a reset link" : "Email me a studio reset link"}
      </button>
      {notice ? (
        <p className={`zonal-recovery-notice${notice.error ? " zonal-recovery-notice-error" : ""}`} role={notice.error ? "alert" : "status"}>
          {!notice.error ? <FiCheckCircle aria-hidden="true" /> : null}<span>{notice.text}</span>
        </p>
      ) : null}
    </div>
  );
}
