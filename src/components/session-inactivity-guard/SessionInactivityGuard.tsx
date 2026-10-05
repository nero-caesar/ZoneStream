"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

const LAST_ACTIVITY_KEY = "zonestream.last-activity";
const KNOWN_SESSION_KEY = "zonestream.session-known";
const SERVER_PING_INTERVAL_MS = 60_000;

type ActivityResult = { authenticated?: boolean; idleTimeoutSeconds?: number };

export default function SessionInactivityGuard() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    let active = true;
    let accountSession = false;
    let developerSession = false;
    let streamActive = false;
    let idleTimeoutMs = 30 * 60 * 1000;
    let lastServerPing = 0;
    let lastSharedWrite = 0;
    let lastClientUpdate = 0;
    let timer: number | undefined;
    let signingOut = false;
    let lastActivityAt = Date.now();
    try {
      lastActivityAt = Number(localStorage.getItem(LAST_ACTIVITY_KEY)) || lastActivityAt;
    } catch {
      // Inactivity tracking still works in browsers that block local storage.
    }

    const getLastActivity = () => {
      try {
        return Number(localStorage.getItem(LAST_ACTIVITY_KEY)) || lastActivityAt;
      } catch {
        return lastActivityAt;
      }
    };

    const recordActivity = () => {
      lastActivityAt = Date.now();
      lastSharedWrite = lastActivityAt;
      try {
        localStorage.setItem(LAST_ACTIVITY_KEY, String(lastActivityAt));
      } catch {
        // The server-side activity cookie still protects the session.
      }
    };

    const logoutAfterInactivity = async () => {
      const elapsed = Date.now() - getLastActivity();
      if (elapsed < idleTimeoutMs) {
        scheduleLogout();
        return;
      }
      if (signingOut || (!accountSession && !developerSession)) return;
      signingOut = true;
      await Promise.allSettled([
        fetch("/api/auth/session", { method: "DELETE" }),
        fetch("/api/developer/session", { method: "DELETE" }),
      ]);
      try {
        localStorage.removeItem(KNOWN_SESSION_KEY);
        localStorage.removeItem(LAST_ACTIVITY_KEY);
      } catch {
        // The server session cookies are cleared even if local storage is unavailable.
      }
      // Let the current route's server guard choose its own sign-in page.
      // Sending every expired session to / made normal navigation snap home.
      if (active) router.refresh();
    };

    const scheduleLogout = () => {
      window.clearTimeout(timer);
      if (accountSession || developerSession) {
        if (streamActive) {
          timer = window.setTimeout(() => void refreshServerSessions(), SERVER_PING_INTERVAL_MS);
          return;
        }
        const remaining = Math.max(0, idleTimeoutMs - (Date.now() - getLastActivity()));
        timer = window.setTimeout(() => void logoutAfterInactivity(), remaining);
      }
    };

    const refreshServerSessions = async () => {
      if (!active || (document.visibilityState === "hidden" && !streamActive)) return;
      if (streamActive) recordActivity();
      const hadSession = accountSession || developerSession;
      const hadKnownSession = (() => {
        try {
          return hadSession || localStorage.getItem(KNOWN_SESSION_KEY) === "1" ||
            Number(localStorage.getItem(LAST_ACTIVITY_KEY)) > 0;
        } catch {
          return hadSession;
        }
      })();
      lastServerPing = Date.now();
      const [accountResponse, developerResponse] = await Promise.all([
        fetch("/api/auth/activity", { method: "POST", cache: "no-store" }).catch(() => null),
        fetch("/api/developer/activity", { method: "POST", cache: "no-store" }).catch(() => null),
      ]);
      const [accountResult, developerResult] = await Promise.all([
        accountResponse?.ok ? accountResponse.json() as Promise<ActivityResult> : null,
        developerResponse?.ok ? developerResponse.json() as Promise<ActivityResult> : null,
      ]);
      if (!active) return;
      accountSession = accountResult?.authenticated === true;
      developerSession = developerResult?.authenticated === true;
      const sessionExpired = hadKnownSession && !accountSession && !developerSession &&
        accountResponse?.status === 401 && developerResponse?.status === 401;
      if (sessionExpired) {
        signingOut = true;
        await Promise.allSettled([
          fetch("/api/auth/session", { method: "DELETE" }),
          fetch("/api/developer/session", { method: "DELETE" }),
        ]);
        try {
          localStorage.removeItem(KNOWN_SESSION_KEY);
          localStorage.removeItem(LAST_ACTIVITY_KEY);
        } catch {
          // The server session cookies are cleared even if local storage is unavailable.
        }
        // Re-render the current route after clearing the expired cookies. Protected
        // pages can then redirect to the matching portal; public pages stay put.
        if (active) router.refresh();
        return;
      }
      if (accountSession || developerSession) {
        try {
          localStorage.setItem(KNOWN_SESSION_KEY, "1");
        } catch {
          // Server-side expiry still protects the session without local storage.
        }
      }
      const activeTimeouts = [accountResult, developerResult]
        .filter((result): result is ActivityResult => result?.authenticated === true)
        .map((result) => Number(result.idleTimeoutSeconds) * 1000)
        .filter((value) => Number.isFinite(value) && value > 0);
      if (activeTimeouts.length) idleTimeoutMs = Math.min(...activeTimeouts);
      scheduleLogout();
    };

    const markActivity = () => {
      if (document.visibilityState === "hidden" || signingOut) return;
      const now = Date.now();
      if ((accountSession || developerSession) && now - getLastActivity() >= idleTimeoutMs) {
        void logoutAfterInactivity();
        return;
      }
      if (now - lastClientUpdate < 400) return;
      lastClientUpdate = now;
      lastActivityAt = now;
      if (now - lastSharedWrite >= 5000) {
        lastSharedWrite = now;
        try {
          localStorage.setItem(LAST_ACTIVITY_KEY, String(lastActivityAt));
        } catch {
          // Keep this tab's inactivity timer even if cross-tab sync is unavailable.
        }
      }
      scheduleLogout();
      if (now - lastServerPing >= SERVER_PING_INTERVAL_MS) void refreshServerSessions();
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== LAST_ACTIVITY_KEY || !event.newValue) return;
      const sharedActivity = Number(event.newValue);
      if (Number.isFinite(sharedActivity) && sharedActivity > lastActivityAt) {
        lastActivityAt = sharedActivity;
        scheduleLogout();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        markActivity();
        void refreshServerSessions();
      }
    };

    const onSessionStarted = () => {
      lastActivityAt = Date.now();
      lastSharedWrite = lastActivityAt;
      try {
        localStorage.setItem(LAST_ACTIVITY_KEY, String(lastActivityAt));
        localStorage.setItem(KNOWN_SESSION_KEY, "1");
      } catch {
        // The session remains protected by its server-side cookie timeout.
      }
      void refreshServerSessions();
    };

    const onSessionEnded = () => {
      accountSession = false;
      developerSession = false;
      window.clearTimeout(timer);
      try {
        localStorage.removeItem(KNOWN_SESSION_KEY);
        localStorage.removeItem(LAST_ACTIVITY_KEY);
      } catch {
        // The next server check still determines whether another session is active.
      }
      void refreshServerSessions();
    };

    const onStreamStateChanged = (event: Event) => {
      streamActive = (event as CustomEvent<{ active?: boolean }>).detail?.active === true;
      recordActivity();
      scheduleLogout();
      if (streamActive) void refreshServerSessions();
    };

    const interactionEvents: Array<keyof WindowEventMap> = ["pointerdown", "pointermove", "keydown", "touchstart", "scroll", "wheel"];
    interactionEvents.forEach((eventName) => window.addEventListener(eventName, markActivity, { passive: true }));
    window.addEventListener("storage", onStorage);
    window.addEventListener("zonestream:session-started", onSessionStarted);
    window.addEventListener("zonestream:session-ended", onSessionEnded);
    window.addEventListener("zonestream:stream-state", onStreamStateChanged);
    document.addEventListener("visibilitychange", onVisibility);
    void refreshServerSessions();

    return () => {
      active = false;
      window.clearTimeout(timer);
      interactionEvents.forEach((eventName) => window.removeEventListener(eventName, markActivity));
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("zonestream:session-started", onSessionStarted);
      window.removeEventListener("zonestream:session-ended", onSessionEnded);
      window.removeEventListener("zonestream:stream-state", onStreamStateChanged);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pathname, router]);

  return null;
}
