"use client";

import { useCallback, useEffect, useState } from "react";
import { FiCheck, FiCopy, FiKey, FiRefreshCw } from "react-icons/fi";
import "./developer-special-access.css";

type SpecialAccessCode = {
  id: string;
  mode: "temporal" | "permanent";
  code: string;
  enabled: boolean;
  createdAt: string;
  connected: boolean;
  redeemedBy?: {
    uid: string;
    name: string;
    audienceType: "individual" | "church";
    firstConnectedAt: string;
    lastConnectedAt: string;
    lastDisconnectedAt?: string;
    lastRoomName: string;
  };
};

function formatTime(value?: string): string {
  if (!value) return "Not yet connected";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Time unavailable" : date.toLocaleString();
}

export default function DeveloperSpecialAccess() {
  const [codes, setCodes] = useState<SpecialAccessCode[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newCode, setNewCode] = useState("");

  const loadCodes = useCallback(async () => {
    try {
      const response = await fetch("/api/developer/special-access", { cache: "no-store" });
      const result = await response.json() as { error?: string; codes?: SpecialAccessCode[] };
      if (!response.ok) throw new Error(result.error || "Special-access codes could not be loaded.");
      setCodes(Array.isArray(result.codes) ? result.codes : []);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Special-access codes could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadCodes(), 0);
    const interval = window.setInterval(() => void loadCodes(), 12000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadCodes]);

  async function createCode(mode: "temporal" | "permanent") {
    setBusy(true);
    setError("");
    setNotice("");
    setNewCode("");
    try {
      const response = await fetch("/api/developer/special-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", mode }),
      });
      const result = await response.json() as { error?: string; code?: SpecialAccessCode };
      if (!response.ok || !result.code) throw new Error(result.error || "The special-access code could not be created.");
      setNewCode(result.code.code);
      setNotice(`${mode === "temporal" ? "Temporal" : "Permanent"} special-access code created.`);
      await loadCodes();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The special-access code could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function setCodeEnabled(code: SpecialAccessCode) {
    const enabled = !code.enabled;
    if (!enabled && code.connected && !window.confirm("Turn off this code and disconnect its current viewer?")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/developer/special-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-enabled", codeId: code.id, enabled }),
      });
      const result = await response.json() as { error?: string; warning?: string };
      if (!response.ok) throw new Error(result.error || "The code setting could not be saved.");
      setNotice(result.warning || `Code ${code.code} is ${enabled ? "on" : "off"}.`);
      await loadCodes();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "The code setting could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setNotice("Code copied. Share it privately with the intended account holder.");
      setError("");
    } catch {
      setError("Copy was blocked. Select the code and copy it manually.");
    }
  }

  return (
    <section className="developer-special-access" aria-labelledby="developer-special-access-title">
      <div className="developer-requests-heading">
        <div>
          <span className="developer-card-eyebrow">PRIVATE PLATFORM ACCESS</span>
          <h2 id="developer-special-access-title"><FiKey aria-hidden="true" /> Developer special access</h2>
        </div>
        <span className="developer-request-count">{codes.length} codes</span>
      </div>
      <p className="developer-requests-description">These codes work after the recipient signs in. They are managed only here and do not appear in the Zonal Studio’s special-code list.</p>

      <div className="developer-special-access-create">
        <button type="button" onClick={() => void createCode("temporal")} disabled={busy || codes.length >= 100}>
          <FiKey aria-hidden="true" /> {busy ? "Working…" : "Create temporary code"}
          <small>For one live service</small>
        </button>
        <button type="button" onClick={() => void createCode("permanent")} disabled={busy || codes.length >= 100}>
          <FiKey aria-hidden="true" /> {busy ? "Working…" : "Create permanent code"}
          <small>Reusable until turned off</small>
        </button>
      </div>
      <p className="developer-special-access-help">
        Temporal codes let the first account reconnect to the same live service, then expire for future services. Permanent codes stay bound to the first account and can be used for later services until you turn them off. The platform-wide viewer pause still blocks every viewer.
      </p>

      {newCode ? (
        <div className="developer-special-access-new-code" role="status">
          <span><FiCheck aria-hidden="true" /> New code</span>
          <code>{newCode}</code>
          <button type="button" onClick={() => void copyCode(newCode)}><FiCopy aria-hidden="true" /> Copy</button>
        </div>
      ) : null}
      {error ? <p className="developer-special-access-message is-error" role="alert">{error}</p> : null}
      {notice ? <p className="developer-special-access-message" role="status">{notice}</p> : null}

      <div className="developer-special-access-list-heading">
        <h3>Generated codes</h3>
        <button type="button" onClick={() => void loadCodes()} disabled={loading || busy} aria-label="Refresh special-access codes"><FiRefreshCw aria-hidden="true" /> Refresh</button>
      </div>

      {loading ? <p className="developer-requests-description">Loading codes…</p> : codes.length ? (
        <ul className="developer-special-access-list">
          {codes.map((code) => (
            <li key={code.id} className={code.enabled ? "is-enabled" : "is-disabled"}>
              <div className="developer-special-access-main">
                <strong className="developer-special-access-code">{code.code}</strong>
                <span className={`developer-special-access-mode is-${code.mode}`}>{code.mode}</span>
                <span className={`developer-special-access-presence ${code.connected ? "is-connected" : ""}`}>{code.connected ? "Connected now" : code.redeemedBy ? "Used" : "Not used"}</span>
              </div>
              <div className="developer-special-access-account">
                <strong>{code.redeemedBy?.name ?? "Waiting for first use"}</strong>
                <small>{code.redeemedBy ? `${code.redeemedBy.audienceType === "church" ? "Church" : "Individual"} account` : "No account has used this code"}</small>
              </div>
              <div className="developer-special-access-times">
                <small>First connected · {formatTime(code.redeemedBy?.firstConnectedAt)}</small>
                <small>Last connected · {formatTime(code.redeemedBy?.lastConnectedAt)}</small>
                {code.redeemedBy?.lastDisconnectedAt ? <small>Last disconnected · {formatTime(code.redeemedBy.lastDisconnectedAt)}</small> : null}
              </div>
              <button className={`developer-special-access-toggle ${code.enabled ? "is-open" : "is-restricted"}`} type="button" aria-pressed={code.enabled} onClick={() => void setCodeEnabled(code)} disabled={busy}>
                {code.enabled ? "On" : "Off"}
              </button>
              <button className="developer-special-access-copy" type="button" onClick={() => void copyCode(code.code)} aria-label={`Copy code ${code.code}`}><FiCopy aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      ) : <p className="developer-requests-description">No Developer special-access codes yet.</p>}
    </section>
  );
}
