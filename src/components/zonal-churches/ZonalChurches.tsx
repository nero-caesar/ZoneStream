"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { FiArrowLeft, FiCopy, FiHome, FiPause, FiPlay, FiPlus, FiRadio, FiTrash2, FiUsers } from "react-icons/fi";
import Brand from "../brand/Brand";
import SignOutButton from "../sign-out-button/SignOutButton";
import "./zonal-churches.css";

type ChurchRecord = {
  uid: string;
  churchName: string;
  churchLocation: string;
  churchType: "local" | "group";
  phone?: string;
  code: string | null;
  status: string;
  createdAt: string;
  connected?: boolean;
  connectedAt?: string | null;
  liveAccessStatusKnown?: boolean;
};

export default function ZonalChurches({ developerMode = false }: { developerMode?: boolean }) {
  const [churches, setChurches] = useState<ChurchRecord[]>([]);
  const [churchName, setChurchName] = useState("");
  const [churchLocation, setChurchLocation] = useState("");
  const [churchType, setChurchType] = useState<"local" | "group">("local");
  const [phone, setPhone] = useState("");
  const [generated, setGenerated] = useState<ChurchRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyChurch, setBusyChurch] = useState("");
  const [error, setError] = useState("");
  const [directoryError, setDirectoryError] = useState("");
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [message, setMessage] = useState("");

  const loadChurches = useCallback(async () => {
    setDirectoryLoading(true);
    try {
      const response = await fetch("/api/zonal/churches", { cache: "no-store" });
      const result = await response.json() as { churches?: ChurchRecord[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not load church accounts.");
      setChurches(result.churches ?? []);
      setDirectoryError("");
    } catch (loadError) {
      setDirectoryError(loadError instanceof Error ? loadError.message : "Could not load church accounts.");
    } finally {
      setDirectoryLoading(false);
    }
  }, []);

  useEffect(() => { void loadChurches(); }, [loadChurches]);

  async function createChurch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    setGenerated(null);
    try {
      const response = await fetch("/api/zonal/churches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ churchName, churchLocation, churchType, phone }),
      });
      const result = await response.json() as { church?: ChurchRecord; error?: string };
      if (!response.ok || !result.church) throw new Error(result.error ?? "Could not create the church account.");
      setGenerated(result.church);
      setChurchName("");
      setChurchLocation("");
      setPhone("");
      setMessage("Church account created. Share its 10-digit code with the church securely.");
      await loadChurches();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create the church account.");
    } finally {
      setBusy(false);
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setMessage("Church code copied.");
    } catch {
      setError("Copy was blocked. Select and copy the code from the list.");
    }
  }

  async function changeChurchAccess(church: ChurchRecord) {
    const action = church.status === "suspended" ? "resume" : "suspend";
    setBusyChurch(church.uid);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/zonal/churches", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: church.uid, action }),
      });
      const result = await response.json() as { error?: string; warning?: string };
      if (!response.ok) throw new Error(result.error ?? "The church access setting could not be changed.");
      setMessage(result.warning || (action === "suspend" ? `${church.churchName} can no longer sign in or join the live service.` : `${church.churchName} can sign in and join again.`));
      await loadChurches();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The church access setting could not be changed.");
    } finally {
      setBusyChurch("");
    }
  }

  async function deleteChurch(church: ChurchRecord) {
    if (!window.confirm(`Delete ${church.churchName}'s account? Its 10-digit code will stop working.`)) return;
    setBusyChurch(church.uid);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/zonal/churches?uid=${encodeURIComponent(church.uid)}`, { method: "DELETE" });
      const result = await response.json() as { error?: string; warning?: string };
      if (!response.ok) throw new Error(result.error ?? "The church account could not be deleted.");
      setMessage(result.warning || `${church.churchName}'s account and code were deleted.`);
      await loadChurches();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The church account could not be deleted.");
    } finally {
      setBusyChurch("");
    }
  }

  return (
    <main className="zonal-churches-page">
      <div className="zonal-churches-shell">
        <header className="zonal-churches-header">
          <Brand />
          <nav>
            <Link href={developerMode ? "/developer/studio" : "/stream/studio"}><FiRadio aria-hidden="true" /> Studio</Link>
            <Link href={developerMode ? "/developer/developer-space" : "/"}><FiArrowLeft aria-hidden="true" /> {developerMode ? "Developer Space" : "Home"}</Link>
            {!developerMode ? <SignOutButton /> : null}
          </nav>
        </header>
        <section className="zonal-churches-intro">
          <span><FiUsers aria-hidden="true" /> ZONAL CHURCH MANAGEMENT</span>
          <h1>Church <em>accounts.</em></h1>
          <p>Create one verified account for each church. ZoneStream generates its permanent 10-digit sign-in code.</p>
        </section>

        <div className="zonal-churches-layout">
          <section className="zonal-church-create-card" aria-labelledby="create-church-title">
            <div className="zonal-church-card-heading"><span><FiPlus aria-hidden="true" /></span><div><small>NEW ACCOUNT</small><h2 id="create-church-title">Register a church</h2></div></div>
            <form onSubmit={createChurch}>
              <label htmlFor="zonal-church-name">Church name</label>
              <input id="zonal-church-name" value={churchName} onChange={(event) => setChurchName(event.target.value)} placeholder="e.g. Grace Centre" maxLength={100} required />
              <label htmlFor="zonal-church-location">Location / area</label>
              <input id="zonal-church-location" value={churchLocation} onChange={(event) => setChurchLocation(event.target.value)} placeholder="e.g. Opolo, Yenagoa" maxLength={120} required />
              <label htmlFor="zonal-church-type">Church type</label>
              <select id="zonal-church-type" value={churchType} onChange={(event) => setChurchType(event.target.value as "local" | "group")}>
                <option value="local">Local church</option>
                <option value="group">Group church</option>
              </select>
              <label htmlFor="zonal-church-phone">Contact phone <span>(optional)</span></label>
              <input id="zonal-church-phone" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Phone number" maxLength={32} />
              {error ? <p className="zonal-church-error" role="alert">{error}</p> : null}
              {message ? <p className="zonal-church-message" role="status">{message}</p> : null}
              <button type="submit" disabled={busy}><FiHome aria-hidden="true" /> {busy ? "Creating account…" : "Create church account"}</button>
            </form>

            {generated?.code ? <div className="zonal-new-code" role="status"><div><small>NEW CHURCH LOGIN CODE</small><strong>{generated.code}</strong><span>{generated.churchName}</span></div><button type="button" onClick={() => void copyCode(generated.code!)}><FiCopy aria-hidden="true" /> Copy</button></div> : null}
          </section>

          <section className="zonal-church-list-card" aria-labelledby="registered-churches-title">
            <div className="zonal-church-card-heading"><span><FiUsers aria-hidden="true" /></span><div><small>DIRECTORY</small><h2 id="registered-churches-title">Registered churches <b>{churches.length}</b></h2></div></div>
            {message ? <p className="zonal-church-message" role="status">{message}</p> : null}
            {directoryError ? <p className="zonal-church-error" role="alert">{directoryError}</p> : null}
            {directoryLoading ? <p className="zonal-church-empty">Loading registered churches…</p> : churches.length ? <ul className="zonal-church-list">{churches.map((church) => <li key={church.uid} className={church.status === "suspended" ? "is-suspended" : ""}>
              <span className="zonal-church-list-icon"><FiHome aria-hidden="true" /></span>
              <span className="zonal-church-list-details"><strong>{church.churchName}</strong><small>{church.churchLocation} · {church.churchType === "group" ? "Group church" : "Local church"}{church.connected ? ` · Connected since ${church.connectedAt ? new Date(church.connectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "now"}` : church.liveAccessStatusKnown === false ? " · Live connection status unavailable" : ""}</small><code>{church.code ?? "Code unavailable"}</code><span className={`zonal-church-status ${church.status === "suspended" ? "is-paused" : "is-active"}`}>{church.status === "suspended" ? "Access halted" : "Access active"}</span></span>
              <div className="zonal-church-item-actions">
                {church.code ? <button type="button" className="zonal-church-icon-action" onClick={() => void copyCode(church.code!)} aria-label={`Copy ${church.churchName} login code`}><FiCopy aria-hidden="true" /></button> : null}
                <button type="button" className="zonal-church-state-action" onClick={() => void changeChurchAccess(church)} disabled={Boolean(busyChurch)}>{busyChurch === church.uid ? "Saving…" : church.status === "suspended" ? <><FiPlay aria-hidden="true" /> Release ID code</> : <><FiPause aria-hidden="true" /> Hold ID code</>}</button>
                <button type="button" className="zonal-church-delete-action" onClick={() => void deleteChurch(church)} disabled={Boolean(busyChurch)} aria-label={`Delete ${church.churchName}`}><FiTrash2 aria-hidden="true" /> Delete</button>
              </div>
            </li>)}</ul> : !directoryError ? <p className="zonal-church-empty">No church accounts yet. Add the first church using the form.</p> : null}
          </section>
        </div>
      </div>
    </main>
  );
}
