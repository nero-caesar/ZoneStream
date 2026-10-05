"use client";

import { useEffect, useState } from "react";
import { FiCheckCircle, FiShield } from "react-icons/fi";
import "./zonal-password-recovery.css";

type ResetStatus = "none" | "pending" | "rejected" | "expired" | "delivered" | "approved" | "unavailable";

export default function ZonalPasswordRecovery({ context }: { context: "login" | "studio" }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [requestStatus, setRequestStatus] = useState<ResetStatus>("none");

  useEffect(() => {
    if (requestStatus !== "pending") return;
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch("/api/auth/zonal-password-reset", { cache: "no-store" });
        const result = await response.json() as { status?: ResetStatus; error?: string };
        if (!active) return;
        if (result.status === "delivered") {
          setRequestStatus("delivered");
          setNotice({ text: "Approved. The reset link has been emailed to the studio recovery address. Check your inbox and spam folder." });
        } else if (result.status === "rejected" || result.status === "expired") {
          setRequestStatus(result.status);
          setNotice({ text: result.status === "rejected" ? "The password change request was declined. You can request again if needed." : "This request expired. You can request a new one.", error: true });
        } else if (result.status === "unavailable") {
          setRequestStatus("unavailable");
          setNotice({ text: result.error || "We could not check this request right now.", error: true });
        }
      } catch {
        // Continue polling while Developer Space reviews the request.
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 4000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [requestStatus]);

  async function requestPasswordChange() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/auth/zonal-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "We could not send this request right now.");
      setRequestStatus("pending");
      setNotice({ text: result.message || "Your request is waiting for approval in Developer Space." });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "We could not send this request right now.", error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`zonal-recovery zonal-recovery-${context}`}>
      {requestStatus !== "approved" ? (
        <button className="zonal-recovery-button" type="button" onClick={() => void requestPasswordChange()} disabled={busy || requestStatus === "pending"}>
          <FiShield aria-hidden="true" />
          {busy ? "Sending request…" : requestStatus === "delivered" ? "Request another reset link" : context === "login" ? "Forgot the studio password? Request a change" : "Request a studio password change"}
        </button>
      ) : null}
      {notice ? (
        <p className={`zonal-recovery-notice${notice.error ? " zonal-recovery-notice-error" : ""}`} role={notice.error ? "alert" : "status"}>
          {!notice.error ? <FiCheckCircle aria-hidden="true" /> : null}<span>{notice.text}</span>
        </p>
      ) : null}
      {requestStatus === "pending" ? <p className="zonal-recovery-pending">Waiting for Developer Space approval. Keep this page open; a link will be emailed after approval.</p> : null}
    </div>
  );
}
