"use client";

import { useActionState, useState } from "react";
import { signIn, signUp, type FormState } from "../actions";

type Mode = "in" | "up";

export function LoginForm({ allowSignup }: { allowSignup: boolean }) {
  const [mode, setMode] = useState<Mode>("in");

  return (
    <div className="glass p-6">
      {allowSignup && (
        <div role="group" aria-label="Choose what to do" className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-black/25 p-1">
          {(
            [
              ["in", "Sign in"],
              ["up", "Create account"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`min-h-11 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                mode === m ? "bg-white/15 text-text" : "text-muted hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {/* Separate forms, so each keeps its own action and message. */}
      {mode === "in" ? (
        <CredentialsForm key="in" action={signIn} submitLabel="Sign in" autoComplete="current-password" />
      ) : (
        <CredentialsForm key="up" action={signUp} submitLabel="Create account" autoComplete="new-password" signingUp onUseSignIn={() => setMode("in")} />
      )}
      {!allowSignup && <p className="mt-4 text-center text-xs text-faint">Accounts are by invitation.</p>}
    </div>
  );
}

function CredentialsForm({
  action,
  submitLabel,
  autoComplete,
  signingUp = false,
  onUseSignIn,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  submitLabel: string;
  autoComplete: string;
  signingUp?: boolean;
  onUseSignIn?: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const failed = Boolean(state?.error);
  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input
          id="email" name="email" type="email" autoComplete="email" required className="field"
          defaultValue={state?.email} aria-invalid={failed || undefined} aria-describedby={failed ? "form-error" : undefined}
        />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input
          id="password" name="password" type="password" autoComplete={autoComplete}
          minLength={signingUp ? 8 : undefined} required className="field"
          aria-invalid={failed || undefined} aria-describedby={failed ? "form-error" : signingUp ? "password-hint" : undefined}
        />
        {signingUp && <p id="password-hint" className="hint">At least 8 characters.</p>}
      </div>
      {/* Both regions are always in the page, so screen readers announce changes reliably. */}
      <p id="form-error" role="alert" className="text-sm text-danger empty:hidden">{state?.error}</p>
      <p role="status" className="text-sm text-ok empty:hidden">{state?.notice}</p>
      {signingUp && (state?.notice || state?.error?.includes("already has an account")) && onUseSignIn && (
        <button type="button" className="btn w-full" onClick={onUseSignIn}>Back to sign in</button>
      )}
      <button className="btn btn-primary w-full" disabled={pending}>
        {pending ? "One moment…" : submitLabel}
      </button>
    </form>
  );
}
