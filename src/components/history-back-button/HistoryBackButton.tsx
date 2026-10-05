"use client";

import { useRouter } from "next/navigation";
import { FiArrowLeft } from "react-icons/fi";

export default function HistoryBackButton({ className, fallbackHref = "/" }: { className?: string; fallbackHref?: string }) {
  const router = useRouter();

  function goBack() {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.replace(fallbackHref);
  }

  return (
    <button className={className} type="button" onClick={goBack}>
      <FiArrowLeft aria-hidden="true" /> Back
    </button>
  );
}
