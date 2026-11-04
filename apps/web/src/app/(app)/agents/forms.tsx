"use client";

import { useActionState } from "react";
import { createAccount, createAgent } from "../../actions";

export function CreateAccountForm() {
  const [state, action, pending] = useActionState(createAccount, undefined);
  return (
    <form action={action} className="space-y-4">
      <div>
        <label className="label" htmlFor="ws-name">Workspace name</label>
        <input id="ws-name" name="name" required maxLength={200} className="field" />
      </div>
      <p role="status" className="text-sm text-danger">{state?.error}</p>
      <button className="btn btn-primary" disabled={pending}>{pending ? "Creating…" : "Create workspace"}</button>
    </form>
  );
}

export function CreateAgentForm({
  accountId,
  templates,
}: {
  accountId: string;
  templates: { key: string; label: string; blurb: string }[];
}) {
  const [state, action, pending] = useActionState(createAgent, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="account_id" value={accountId} />
      <div>
        <label className="label" htmlFor="agent-name">Name</label>
        <input id="agent-name" name="name" required maxLength={200} placeholder="Front desk" className="field" />
      </div>
      <fieldset>
        <legend className="label">Template</legend>
        <div className="space-y-2">
          {templates.map((t, i) => (
            <label key={t.key} className="flex cursor-pointer gap-3 rounded-lg border border-line p-3 has-[:checked]:border-accent/60 has-[:checked]:bg-white/5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
              <input type="radio" name="template" value={t.key} defaultChecked={i === 0} className="mt-1 accent-[var(--accent)]" />
              <span>
                <span className="block text-sm font-medium">{t.label}</span>
                <span className="block text-xs text-muted">{t.blurb}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p role="status" className="text-sm text-danger">{state?.error}</p>
      <button className="btn btn-primary w-full" disabled={pending}>{pending ? "Creating…" : "Create agent"}</button>
    </form>
  );
}
