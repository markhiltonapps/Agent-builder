"use client";

import { useActionState } from "react";
import { createAccount, syncAllToVotel } from "../../actions";

export function CreateAccountForm() {
  const [state, action, pending] = useActionState(createAccount, undefined);
  return (
    <form action={action} className="space-y-4">
      <div>
        <label className="label" htmlFor="ws-name">Workspace name</label>
        <input id="ws-name" name="name" required maxLength={200} className="field" aria-describedby="ws-error" aria-invalid={state?.error ? true : undefined} />
      </div>
      <p id="ws-error" role="alert" className="text-sm text-danger empty:sr-only">{state?.error}</p>
      <button className="btn btn-primary" disabled={pending}>{pending ? "Creating…" : "Create workspace"}</button>
    </form>
  );
}

/** One click sends every agent to Votel's "Agent Builder OS" board. */
export function SyncVotelButton() {
  const [state, action, pending] = useActionState(syncAllToVotel, undefined);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3" aria-busy={pending}>
      <button className="btn" disabled={pending}>{pending ? "Sending to Votel…" : "Send agents to Votel"}</button>
      <p role="status" aria-live="polite" className={`text-sm empty:sr-only ${state?.error ? "text-danger" : "text-ok"}`}>
        {state?.error ?? state?.message ?? ""}
      </p>
    </form>
  );
}
