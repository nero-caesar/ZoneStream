"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { FiLogOut } from "react-icons/fi";
import { getFirebaseClient } from "../../lib/firebase/client";
import "./sign-out-button.css";

export default function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    await fetch("/api/auth/session", { method: "DELETE" });
    window.dispatchEvent(new Event("zonestream:session-ended"));
    try {
      const { auth } = getFirebaseClient();
      await signOut(auth);
    } catch {
      // The server session has already been cleared.
    }
    router.replace("/");
  }

  return <button className="zone-sign-out" type="button" onClick={() => void logout()} disabled={busy}><FiLogOut aria-hidden="true" /> {busy ? "Signing out…" : "Sign out"}</button>;
}
