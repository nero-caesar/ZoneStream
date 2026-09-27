"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  FiArrowLeft,
  FiArrowRight,
  FiCheckCircle,
  FiEye,
  FiEyeOff,
  FiHome,
  FiUser,
} from "react-icons/fi";
import { FaGoogle } from "react-icons/fa";
import type { FormMode, Portal } from "../types";
import "./account-form.css";

type FieldProps = {
  id: string;
  label: string;
  type?: string;
  placeholder: string;
  autoComplete?: string;
};

function Field({ id, label, type = "text", placeholder, autoComplete }: FieldProps) {
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required
        className="form-input"
      />
    </div>
  );
}

function PasswordField({
  id,
  label,
  placeholder,
  autoComplete,
  visible,
  onToggle,
}: {
  id: string;
  label: string;
  placeholder: string;
  autoComplete: string;
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <div className="password-control">
        <input
          id={id}
          name={id}
          type={visible ? "text" : "password"}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required
          minLength={8}
          className="form-input"
        />
        <button
          className="password-toggle"
          type="button"
          aria-label={visible ? "Hide password" : "Show password"}
          onClick={onToggle}
        >
          {visible ? <FiEyeOff size={17} /> : <FiEye size={17} />}
        </button>
      </div>
    </div>
  );
}

export default function AccountForm({ portal, mode }: { portal: Portal; mode: FormMode }) {
  const [resetMode, setResetMode] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const isChurch = portal === "church";
  const activeMode = resetMode ? "reset" : mode;
  const signInHref = isChurch ? "/login-page-church" : "/login-page-individual";
  const createHref = isChurch ? "/signup-page-church" : "/signup-page-individual";

  const title = activeMode === "reset"
    ? "Reset your password"
    : activeMode === "create"
      ? isChurch ? "Register your church" : "Create your account"
      : isChurch ? "Welcome, church" : "Welcome back";
  const subtitle = activeMode === "reset"
    ? "We’ll help you get back into your ZoneStream account."
    : activeMode === "create"
      ? "Set up your ZoneStream connection."
      : "Sign in to continue to ZoneStream.";

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (activeMode === "create") {
      const submittedValues = new FormData(event.currentTarget);
      if (submittedValues.get("password") !== submittedValues.get("confirm-password")) {
        setNotice("Your passwords do not match yet.");
        return;
      }
    }

    setNotice(
      activeMode === "reset"
        ? "Password reset is ready to connect to ZoneStream."
        : activeMode === "create"
          ? "Account creation is ready to connect to ZoneStream."
          : "Sign-in is ready to connect to ZoneStream.",
    );
  }

  function switchToReset() {
    setResetMode(true);
    setNotice("");
  }

  function switchToSignIn() {
    setResetMode(false);
    setNotice("");
    setPasswordVisible(false);
  }

  return (
    <div className="auth-card">
      <header className="form-heading">
        <span className="form-heading-icon" aria-hidden="true">
          {isChurch ? <FiHome size={22} /> : <FiUser size={22} />}
        </span>
        <span>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </span>
      </header>

      {activeMode !== "reset" ? (
        <nav className="form-tabs" aria-label="Account options">
          <Link
            href={signInHref}
            aria-current={mode === "signin" ? "page" : undefined}
            className={mode === "signin" ? "form-tab active" : "form-tab"}
          >
            Sign in
          </Link>
          <Link
            href={createHref}
            aria-current={mode === "create" ? "page" : undefined}
            className={mode === "create" ? "form-tab active" : "form-tab"}
          >
            Create account
          </Link>
        </nav>
      ) : (
        <button className="reset-back" type="button" onClick={switchToSignIn}>
          <FiArrowLeft size={15} aria-hidden="true" /> Back to sign in
        </button>
      )}

      <form className="account-form" onSubmit={submitForm}>
        {activeMode === "create" && !isChurch && (
          <Field id="full-name" label="Full name" placeholder="Your full name" autoComplete="name" />
        )}
        {activeMode === "create" && isChurch && (
          <>
            <Field id="church-name" label="Church name" placeholder="e.g. CE Yenagoa Central" autoComplete="organization" />
            <Field id="church-location" label="Church location / area" placeholder="e.g. Opolo, Yenagoa" autoComplete="address-level2" />
          </>
        )}

        <Field
          id={isChurch && activeMode !== "reset" ? "church-identifier" : "email"}
          label={isChurch && activeMode !== "reset" ? "Church identifier or email" : "Email address"}
          type={isChurch && activeMode !== "reset" ? "text" : "email"}
          placeholder={isChurch && activeMode !== "reset" ? "Church ID or email address" : "you@example.com"}
          autoComplete={isChurch && activeMode !== "reset" ? "username" : "email"}
        />

        {activeMode === "create" && isChurch && (
          <Field id="church-phone" label="Church contact information" type="tel" placeholder="Phone number" autoComplete="tel" />
        )}

        {activeMode !== "reset" && (
          <>
            <PasswordField
              id="password"
              label="Password"
              placeholder="Enter your password"
              autoComplete={activeMode === "create" ? "new-password" : "current-password"}
              visible={passwordVisible}
              onToggle={() => setPasswordVisible((visible) => !visible)}
            />
            {activeMode === "create" && (
              <PasswordField
                id="confirm-password"
                label="Confirm password"
                placeholder="Confirm your password"
                autoComplete="new-password"
                visible={passwordVisible}
                onToggle={() => setPasswordVisible((visible) => !visible)}
              />
            )}
          </>
        )}

        {activeMode === "signin" && (
          <div className="form-utilities">
            <label className="remember-option">
              <input type="checkbox" name="remember" />
              <span>Remember me</span>
            </label>
            <button className="text-action" type="button" onClick={switchToReset}>
              Forgot password?
            </button>
          </div>
        )}

        {notice && <p className="form-notice" role="status"><FiCheckCircle size={16} />{notice}</p>}

        <button className="submit-button" type="submit">
          <span>{activeMode === "reset" ? "Send reset link" : activeMode === "create" ? isChurch ? "Register church" : "Create account" : "Sign in"}</span>
          <FiArrowRight size={18} aria-hidden="true" />
        </button>
      </form>

      {activeMode === "signin" && !isChurch && (
        <>
          <div className="form-divider"><span>or continue with</span></div>
          <button className="google-button" type="button" onClick={() => setNotice("Google sign-in is ready to connect to ZoneStream.")}>
            <FaGoogle size={15} aria-hidden="true" />
            <span>Google</span>
          </button>
        </>
      )}

      <p className="account-switch">
        {activeMode === "reset" ? (
          <>Remember your password? <button type="button" onClick={switchToSignIn}>Sign in</button></>
        ) : activeMode === "create" ? (
          <>Already have an account? <Link href={signInHref}>Sign in</Link></>
        ) : (
          <>New to ZoneStream? <Link href={createHref}>Create an account</Link></>
        )}
      </p>

      <p className="terms-copy">
        By continuing, you agree to ZoneStream&apos;s <a href="#terms">Terms of Service</a> and <a href="#privacy">Privacy Policy</a>.
      </p>
    </div>
  );
}
