"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FiBell, FiCheck, FiExternalLink } from "react-icons/fi";
import { getFirebaseClient } from "../../lib/firebase/client";
import "./individual-notifications.css";

const DEVICE_FID_KEY = "zonestream-individual-push-fid";
const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
const MESSAGING_SENDER_ID = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;

type PushPayload = { title: string; body: string; url: string; kind: "live_started" | "recording_uploaded" };

export default function IndividualNotifications({ onNotification }: { onNotification: (notification: PushPayload) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [incoming, setIncoming] = useState<PushPayload | null>(null);
  const pushConfigured = Boolean(VAPID_KEY && MESSAGING_SENDER_ID);

  useEffect(() => {
    let active = true;
    if (!pushConfigured || typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
      const timeout = window.setTimeout(() => { if (active) setSupported(false); }, 0);
      return () => {
        active = false;
        window.clearTimeout(timeout);
      };
    }

    void import("firebase/messaging").then(async ({ isSupported }) => {
      const isBrowserSupported = await isSupported();
      if (!active) return;
      setSupported(isBrowserSupported);

      const fid = window.localStorage.getItem(DEVICE_FID_KEY);
      if (!isBrowserSupported || Notification.permission !== "granted" || !fid) return;
      const response = await fetch(`/api/notifications/device?fid=${encodeURIComponent(fid)}`, { cache: "no-store" });
      const result = await response.json() as { enabled?: boolean };
      if (active) setEnabled(result.enabled === true);
    }).catch(() => {
      if (active) setSupported(false);
    });

    return () => { active = false; };
  }, [pushConfigured]);

  useEffect(() => {
    if (!enabled || !pushConfigured || typeof window === "undefined") return;
    let active = true;
    let unsubscribe: () => void = () => {};

    void (async () => {
      const { isSupported, getMessaging, onMessage } = await import("firebase/messaging");
      if (!await isSupported()) return;
      const registration = await navigator.serviceWorker.getRegistration("/");
      if (!registration) return;
      const { app } = getFirebaseClient();
      unsubscribe = onMessage(getMessaging(app), (payload) => {
        const data = payload.data ?? {};
        if (data.kind !== "live_started" && data.kind !== "recording_uploaded") return;
        const notification: PushPayload = {
          title: data.title || "ZoneStream update",
          body: data.body || "There is a new update from ZoneStream.",
          url: data.url || "/dashboard",
          kind: data.kind,
        };
        if (active) {
          setIncoming(notification);
          onNotification(notification);
        }
      });
    })().catch(() => undefined);

    return () => {
      active = false;
      unsubscribe();
    };
  }, [enabled, onNotification, pushConfigured]);

  const disableNotifications = useCallback(async () => {
    setBusy(true);
    setError("");
    setMessage("");
    const fid = window.localStorage.getItem(DEVICE_FID_KEY);
    try {
      if (fid) {
        const response = await fetch("/api/notifications/device", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fid }),
        });
        if (!response.ok) throw new Error("The notification device could not be removed from the account.");
      }
      try {
        const { getMessaging, unregister } = await import("firebase/messaging");
        const { app } = getFirebaseClient();
        await unregister(getMessaging(app));
      } catch {
        // The server subscription is removed even if the browser cannot unregister its local worker.
      }
      window.localStorage.removeItem(DEVICE_FID_KEY);
      setEnabled(false);
      setMessage("Notifications are off on this device.");
    } catch {
      setError("Could not turn off push notifications on this device. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const enableNotifications = useCallback(async () => {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      if (!pushConfigured || !VAPID_KEY) throw new Error("Notifications are not ready on this device yet. Please try again later.");
      if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
        throw new Error("This browser does not support device notifications.");
      }

      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Allow notifications in your browser to receive ZoneStream alerts.");

      const { isSupported, getMessaging, register, onRegistered } = await import("firebase/messaging");
      if (!await isSupported()) throw new Error("This browser cannot receive ZoneStream push notifications.");
      const serviceWorkerRegistration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
      const { app } = getFirebaseClient();
      const messaging = getMessaging(app);
      let removeRegistrationListener: () => void = () => {};
      let timeoutId = 0;
      const fidPromise = new Promise<string>((resolve, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error("ZoneStream could not finish setting up notifications. Please try again.")), 15000);
        removeRegistrationListener = onRegistered(messaging, (fid) => {
          window.clearTimeout(timeoutId);
          resolve(fid);
        });
        void register(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration }).catch(reject);
      });

      let fid: string;
      try {
        fid = await fidPromise;
      } finally {
        window.clearTimeout(timeoutId);
        removeRegistrationListener();
      }

      const response = await fetch("/api/notifications/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fid }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not save this notification device.");

      window.localStorage.setItem(DEVICE_FID_KEY, fid);
      setEnabled(true);
      setMessage("You’ll get an alert when a live service starts or a new recording is uploaded.");
    } catch (enableError) {
      setError(enableError instanceof Error ? enableError.message : "Notifications could not be enabled. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [pushConfigured]);

  return (
    <section className="member-dashboard-notifications" aria-labelledby="viewer-notifications-title">
      <div className="member-dashboard-notifications-main">
        <span className="member-dashboard-notifications-icon"><FiBell aria-hidden="true" /></span>
        <div className="member-dashboard-notifications-copy">
          <span className="member-dashboard-notifications-eyebrow">INDIVIDUAL DEVICE ALERTS</span>
          <h2 id="viewer-notifications-title">Know when ZoneStream is live</h2>
          <p>Get an optional device alert when an eligible live service starts or a new recorded message is shared. Church accounts do not receive viewer alerts.</p>
        </div>
        <button className={`member-dashboard-notifications-button ${enabled ? "is-enabled" : ""}`} type="button" disabled={busy || supported === false || !pushConfigured} onClick={() => void (enabled ? disableNotifications() : enableNotifications())}>
          {enabled ? <FiCheck aria-hidden="true" /> : <FiBell aria-hidden="true" />}
          {busy ? "Updating…" : enabled ? "Turn off" : supported === null ? "Checking…" : "Enable notifications"}
        </button>
      </div>
      {!pushConfigured ? <p className="member-dashboard-notifications-note">Notifications are not available right now. Please try again later.</p> : supported === false ? <p className="member-dashboard-notifications-note">Push notifications are unavailable in this browser. On iPhone or iPad, add ZoneStream to the Home Screen first.</p> : null}
      {message ? <p className="member-dashboard-notifications-message" role="status">{message}</p> : null}
      {error ? <p className="member-dashboard-notifications-error" role="alert">{error}</p> : null}
      {incoming ? (
        <div className="member-dashboard-push-alert" role="status">
          <div><strong>{incoming.title}</strong><span>{incoming.body}</span></div>
          <Link href={incoming.url} onClick={() => setIncoming(null)}>Open <FiExternalLink aria-hidden="true" /></Link>
          <button type="button" aria-label="Dismiss notification" onClick={() => setIncoming(null)}>Dismiss</button>
        </div>
      ) : null}
    </section>
  );
}
