"use client";

import { useActionState, useState } from "react";
import { signIn, signUp } from "../actions";

export function LoginForm({ allowSignup }: { allowSignup: boolean }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [state, action, pending] = useActionState(mode === "in" ? signIn : signUp, undefined);

  return (
    <form action={action} className="glass space-y-4 p-6" aria-describedby="form-status">
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required className="field" defaultValue={state?.email} />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "in" ? "current-password" : "new-password"}
          minLength={mode === "up" ? 8 : undefined}
          required
          className="field"
        />
      </div>
      <p id="form-status" role="status" className={state?.error ? "text-sm text-danger" : "text-sm text-ok"}>
        {state?.error ?? state?.notice}
      </p>
      <button className="btn btn-primary w-full" disabled={pending}>
        {pending ? "One moment…" : mode === "in" ? "Sign in" : "Create account"}
      </button>
      {allowSignup ? (
        <button
          type="button"
          className="btn btn-quiet w-full"
          onClick={() => setMode(mode === "in" ? "up" : "in")}
        >
          {mode === "in" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>
      ) : (
        <p className="text-center text-xs text-faint">Accounts are by invitation.</p>
      )}
    </form>
  );
}
