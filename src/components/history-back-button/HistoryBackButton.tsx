"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FiArrowLeft } from "react-icons/fi";

export default function HistoryBackButton({
  className,
  fallbackHref = "/",
  beforeNavigate,
}: {
  className?: string;
  fallbackHref?: string;
  beforeNavigate?: () => Promise<boolean>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function goBack() {
    if (busy) return;
    setBusy(true);
    if (beforeNavigate) {
      const mayNavigate = await beforeNavigate().catch(() => false);
      if (!mayNavigate) {
        setBusy(false);
        return;
      }
    }
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.replace(fallbackHref);
  }

  return (
    <button className={className} type="button" onClick={() => void goBack()} disabled={busy}>
      <FiArrowLeft aria-hidden="true" /> {busy ? "Ending service…" : "Back"}
    </button>
  );
}
