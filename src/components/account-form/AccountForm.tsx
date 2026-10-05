"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import {
  FiArrowLeft,
  FiArrowRight,
  FiCheckCircle,
  FiEye,
  FiEyeOff,
  FiHome,
  FiShield,
  FiUser,
} from "react-icons/fi";
import type { FormMode, Portal } from "../types";
import ZonalPasswordRecovery from "../zonal-password-recovery/ZonalPasswordRecovery";
import { prepareInMemoryAuth } from "../../lib/firebase/client";
import "./account-form.css";

type ProfileResult = { profile?: { role?: string }; error?: string };

function errorMessage(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password") || code.includes("auth/user-not-found")) {
    return "Those sign-in details don’t match an account. Check them and try again.";
  }
  if (code.includes("auth/email-already-in-use")) return "An account already uses this email. Try signing in instead.";
  if (code.includes("auth/weak-password")) return "Choose a password with at least 8 characters.";
  if (code.includes("auth/too-many-requests")) return "Too many attempts. Wait a little and try again.";
  if (error instanceof Error && /unexpected end of json|json parse|failed to execute ['\"]?json|unexpected token|failed to fetch|networkerror|load failed/i.test(error.message)) {
    return "We couldn’t complete your sign-in. Please check your connection and try again.";
  }
  if (error instanceof Error && /firebase|cloudflare|livekit|identitytoolkit/i.test(error.message)) return "We couldn’t complete that request. Please try again.";
  if (error instanceof Error && error.message) return error.message;
  return "We couldn’t complete that request. Please try again.";
}

async function postJson<T extends ProfileResult>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let result: T | null = null;

  if (responseText.trim()) {
    try {
      result = JSON.parse(responseText) as T;
    } catch {
      // A proxy or server failure can return an empty body or an HTML error page.
    }
  }

  if (!response.ok) {
    throw new Error(result?.error || "We couldn’t complete that request. Please try again.");
  }
  if (!result) throw new Error("We couldn’t complete that request. Please try again in a moment.");
  return result;
}

function getPresenterReturnPath(): string | null {
  const nextPath = new URLSearchParams(window.location.search).get("next");
  if (!nextPath || !nextPath.startsWith("/stream/presenter/") || nextPath.startsWith("//")) return null;
  try {
    const destination = new URL(nextPath, window.location.origin);
    if (destination.origin !== window.location.origin || !/^\/stream\/presenter\/[a-z0-9][a-z0-9-]{5,79}$/i.test(destination.pathname)) return null;
    return `${destination.pathname}${destination.search}`;
  } catch {
    return null;
  }
}

export default function AccountForm({ portal, mode }: { portal: Portal; mode: FormMode }) {
  const router = useRouter();
  const [resetMode, setResetMode] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; isError?: boolean } | null>(null);
  const isChurch = portal === "church";
  const isZonal = portal === "zonal";
  const isIndividual = !isChurch && !isZonal;
  const activeMode = resetMode ? "reset" : mode;
  const signInHref = isChurch ? "/login-page-church" : isZonal ? "/login-page-zonal" : "/login-page-individual";
  const createHref = "/signup-page-individual";

  const title = activeMode === "reset"
    ? isZonal ? "Recover studio access" : "Reset your password"
    : activeMode === "create"
      ? isZonal ? "Set or reset the studio password" : "Create your account"
      : isChurch ? "Church access" : isZonal ? "Zonal Church sign in" : "Welcome back";
  const subtitle = activeMode === "reset"
    ? isZonal ? "Request approval to choose a new studio password." : "We’ll send a password reset link to your email."
    : activeMode === "create"
      ? isZonal ? "Choose a new shared password for the studio." : "Create your individual ZoneStream account."
      : isChurch ? "Enter the 10-digit code given to your church." : isZonal
        ? "Enter the shared password to manage the ZoneStream broadcast studio."
        : "Sign in to continue to ZoneStream.";

  async function establishSession(user: User, expectedRole: Portal, auth: Awaited<ReturnType<typeof prepareInMemoryAuth>>, rememberMe = false) {
    const idToken = await user.getIdToken(true);
    const response = await postJson<ProfileResult>("/api/auth/session", { idToken, rememberMe });
    if (response.profile?.role !== expectedRole) {
      await fetch("/api/auth/session", { method: "DELETE" });
      await signOut(auth);
      throw new Error("This account belongs to a different ZoneStream portal.");
    }
    window.dispatchEvent(new Event("zonestream:session-started"));
    router.replace(expectedRole === "zonal" ? "/stream/studio" : getPresenterReturnPath() ?? "/dashboard");
  }

  async function createIndividualProfile(user: User, displayName: string) {
    const idToken = await user.getIdToken(true);
    await postJson("/api/auth/register", { idToken, role: "individual", displayName });
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    try {
      if (isZonal) {
        if (activeMode === "reset") {
          const result = await postJson<ProfileResult & { message?: string }>("/api/auth/zonal-password-reset", {});
          setNotice({ text: result.message ?? "Your request is waiting for approval in Developer Space." });
          return;
        }
        if (activeMode === "create" && password !== form.get("confirm-password")) {
          throw new Error("Your passwords do not match yet.");
        }
        if (activeMode === "signin") {
          await postJson("/api/auth/zonal-login", { password });
          window.dispatchEvent(new Event("zonestream:session-started"));
          router.replace("/stream/studio");
          return;
        }

        const auth = await prepareInMemoryAuth();
        const route = "/api/auth/zonal-setup";
        const result = await postJson<{ customToken?: string; error?: string }>(route, { password });
        if (!result.customToken) throw new Error("We couldn’t open the Zonal Church account.");
        const credential = await signInWithCustomToken(auth, result.customToken);
        await establishSession(credential.user, "zonal", auth);
        return;
      }

      const auth = await prepareInMemoryAuth();

      if (activeMode === "reset") {
        await sendPasswordResetEmail(auth, email);
        setNotice({ text: "If an account uses that email, a password reset link is on its way." });
        setBusy(false);
        return;
      }

      if (isChurch) {
        const result = await postJson<{ customToken?: string; error?: string }>("/api/auth/church-login", {
          code: String(form.get("church-code") ?? "").replace(/\D/g, ""),
        });
        if (!result.customToken) throw new Error("We couldn’t sign in with that church code.");
        const credential = await signInWithCustomToken(auth, result.customToken);
        await establishSession(credential.user, "church", auth);
        return;
      }

      if (activeMode === "create") {
        const displayName = String(form.get("full-name") ?? "").trim();
        if (displayName.length < 2) throw new Error("Enter your full name to create an account.");
        if (password !== form.get("confirm-password")) throw new Error("Your passwords do not match yet.");
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        try {
          await updateProfile(credential.user, { displayName });
          await createIndividualProfile(credential.user, displayName);
          await establishSession(credential.user, "individual", auth);
        } catch (error) {
          await signOut(auth).catch(() => undefined);
          throw error;
        }
        return;
      }

      const credential = await signInWithEmailAndPassword(auth, email, password);
        await establishSession(credential.user, "individual", auth, form.get("remember") === "on");
    } catch (error) {
      setNotice({ text: errorMessage(error), isError: true });
    } finally {
      setBusy(false);
    }
  }

  function switchToReset() {
    setResetMode(true);
    setNotice(null);
  }

  function switchToSignIn() {
    setResetMode(false);
    setNotice(null);
    setPasswordVisible(false);
  }

  return (
    <div className="auth-card">
      <header className="form-heading">
        <span className="form-heading-icon" aria-hidden="true">
          {isChurch ? <FiHome size={22} /> : isZonal ? <FiShield size={22} /> : <FiUser size={22} />}
        </span>
        <span>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </span>
      </header>

      {isIndividual && activeMode !== "reset" ? (
        <nav className="form-tabs" aria-label="Account options">
          <Link href="/login-page-individual" aria-current={mode === "signin" ? "page" : undefined} className={mode === "signin" ? "form-tab active" : "form-tab"}>Sign in</Link>
          <Link href={createHref} aria-current={mode === "create" ? "page" : undefined} className={mode === "create" ? "form-tab active" : "form-tab"}>Create account</Link>
        </nav>
      ) : activeMode === "reset" ? (
        <button className="reset-back" type="button" onClick={switchToSignIn}><FiArrowLeft size={15} aria-hidden="true" /> Back to sign in</button>
      ) : null}

      <form className="account-form" onSubmit={submitForm}>
        {activeMode === "create" && isIndividual ? (
          <div className="form-field">
            <label htmlFor="full-name">Full name</label>
            <input id="full-name" name="full-name" type="text" placeholder="Your full name" autoComplete="name" required minLength={2} className="form-input" />
          </div>
        ) : null}

        {isChurch && activeMode !== "reset" ? (
          <div className="form-field">
            <label htmlFor="church-code">10-digit church code</label>
            <input id="church-code" name="church-code" type="text" inputMode="numeric" pattern="[0-9]{10}" maxLength={10} placeholder="Enter your 10-digit code" autoComplete="one-time-code" required className="form-input church-code-input" />
            <small className="field-help">The registered church name will be matched automatically.</small>
          </div>
        ) : null}

        {isIndividual ? (
          <div className="form-field">
            <label htmlFor="email">Email address</label>
            <input id="email" name="email" type="email" placeholder="you@example.com" autoComplete="email" required className="form-input" />
          </div>
        ) : null}

        {activeMode !== "reset" && !isChurch ? (
          <div className="form-field">
            <label htmlFor="password">Password</label>
            <div className="password-control">
              <input id="password" name="password" type={passwordVisible ? "text" : "password"} placeholder={isZonal ? "Enter the shared password" : "Enter your password"} autoComplete={activeMode === "create" ? "new-password" : "current-password"} required minLength={isZonal ? 14 : 8} maxLength={128} className="form-input" />
              <button className="password-toggle" type="button" aria-label={passwordVisible ? "Hide password" : "Show password"} onClick={() => setPasswordVisible((visible) => !visible)}>
                {passwordVisible ? <FiEyeOff size={17} /> : <FiEye size={17} />}
              </button>
            </div>
          </div>
        ) : null}

        {activeMode === "create" && (isIndividual || isZonal) ? (
          <div className="form-field">
            <label htmlFor="confirm-password">Confirm password</label>
            <div className="password-control">
              <input id="confirm-password" name="confirm-password" type={passwordVisible ? "text" : "password"} placeholder="Confirm your password" autoComplete="new-password" required minLength={isZonal ? 14 : 8} maxLength={128} className="form-input" />
              <button className="password-toggle" type="button" aria-label={passwordVisible ? "Hide password" : "Show password"} onClick={() => setPasswordVisible((visible) => !visible)}>
                {passwordVisible ? <FiEyeOff size={17} /> : <FiEye size={17} />}
              </button>
            </div>
          </div>
        ) : null}

        {activeMode === "signin" && isIndividual ? (
          <div className="form-utilities">
            <label className="remember-option"><input type="checkbox" name="remember" /><span>Remember me</span></label>
            <button className="text-action" type="button" onClick={switchToReset}>Forgot password?</button>
          </div>
        ) : null}

        {notice ? <p className={`form-notice${notice.isError ? " form-notice-error" : ""}`} role={notice.isError ? "alert" : "status"}><FiCheckCircle size={16} />{notice.text}</p> : null}

        <button className="submit-button" type="submit" disabled={busy}>
          <span>{busy ? "Please wait…" : activeMode === "reset" ? "Send reset link" : activeMode === "create" ? isZonal ? "Save studio password" : "Create account" : isChurch ? "Continue to ZoneStream" : isZonal ? "Enter the studio" : "Sign in"}</span>
          <FiArrowRight size={18} aria-hidden="true" />
        </button>
      </form>

      {activeMode === "signin" && isZonal ? <ZonalPasswordRecovery context="login" /> : null}

      {isZonal ? (
        activeMode === "create" ? <p className="account-switch">Finished setting the password? <Link href={signInHref}>Return to studio sign in</Link></p>
          : null
      ) : !isChurch ? <p className="account-switch">{activeMode === "reset" ? <>Remember your password? <button type="button" onClick={switchToSignIn}>Sign in</button></> : activeMode === "create" ? <>Already have an account? <Link href={signInHref}>Sign in</Link></> : <>New to ZoneStream? <Link href={createHref}>Create an account</Link></>}</p> : null}
      {isChurch ? <p className="account-switch church-access-note">Need a church code? Contact the Zonal Church.</p> : null}
      {activeMode !== "reset" && !isChurch && !isZonal ? <p className="terms-copy">By continuing, you agree to ZoneStream&apos;s <a href="#terms">Terms of Service</a> and <a href="#privacy">Privacy Policy</a>.</p> : null}
    </div>
  );
}
