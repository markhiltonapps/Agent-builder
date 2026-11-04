"use client";

import { useActionState, useState } from "react";
import { createAccount, createAgent } from "../../actions";

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

export function CreateAgentForm({
  accountId,
  templates,
}: {
  accountId: string;
  templates: { key: string; label: string; blurb: string }[];
}) {
  const [state, action, pending] = useActionState(createAgent, undefined);
  const [mode, setMode] = useState<"template" | "ai">("template");
  return (
    <form action={action} className="space-y-4" aria-busy={pending}>
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="mode" value={mode} />
      <div>
        <label className="label" htmlFor="agent-name">Agent name</label>
        <input id="agent-name" name="name" required maxLength={200} placeholder="e.g. Weekend receptionist" className="field" />
      </div>

      <fieldset>
        <legend className="label">How do you want to start?</legend>
        <div className="space-y-2">
          <label className="flex min-h-11 cursor-pointer gap-3 rounded-lg border border-line p-3 has-[:checked]:border-accent/60 has-[:checked]:bg-white/5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
            <input type="radio" name="how" checked={mode === "template"} onChange={() => setMode("template")} className="mt-1 size-4" />
            <span>
              <span className="block text-sm font-medium">{templates.length === 1 ? `From the ${templates[0].label} template` : "From a template"}</span>
              <span className="block text-xs text-muted">{templates.length === 1 ? templates[0].blurb : "A ready-made agent you can edit."}</span>
            </span>
          </label>
          <label className="flex min-h-11 cursor-pointer gap-3 rounded-lg border border-line p-3 has-[:checked]:border-accent/60 has-[:checked]:bg-white/5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
            <input type="radio" name="how" checked={mode === "ai"} onChange={() => setMode("ai")} className="mt-1 size-4" />
            <span>
              <span className="block text-sm font-medium">Let AI draft it from a description</span>
              <span className="block text-xs text-muted">You review and edit everything before it goes live.</span>
            </span>
          </label>
        </div>
      </fieldset>

      {mode === "template" && templates.length === 1 && <input type="hidden" name="template" value={templates[0].key} />}
      {mode === "template" && templates.length > 1 ? (
        <fieldset>
          <legend className="label">Template</legend>
          <div className="space-y-2">
            {templates.map((t, i) => (
              <label key={t.key} className="flex min-h-11 cursor-pointer gap-3 rounded-lg border border-line p-3 has-[:checked]:border-accent/60 has-[:checked]:bg-white/5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
                <input type="radio" name="template" value={t.key} defaultChecked={i === 0} className="mt-1 size-4" />
                <span>
                  <span className="block text-sm font-medium">{t.label}</span>
                  <span className="block text-xs text-muted">{t.blurb}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : mode === "ai" ? (
        <div>
          <label className="label" htmlFor="description">About the business</label>
          <textarea
            id="description" name="description" rows={6} maxLength={4000} required className="field"
            aria-describedby="description-hint"
            placeholder="For example: Bright Smile Dental in Scottsdale, open Monday to Thursday 8 to 5. Callers mostly want to book a cleaning, ask about insurance, or report a toothache."
          />
          <p id="description-hint" className="hint">What it does, when it&apos;s open, who calls and why. Don&apos;t include prices unless you want the agent to quote them.</p>
        </div>
      ) : null}

      <p role="status" aria-live="polite" className="text-sm text-muted empty:sr-only">
        {pending && mode === "ai" ? "Drafting your agent. This can take up to a minute." : ""}
      </p>
      <p id="create-error" role="alert" className="text-sm text-danger empty:sr-only">{state?.error}</p>
      <button className="btn btn-primary w-full" disabled={pending}>
        {pending ? (mode === "ai" ? "Drafting your agent… this can take up to a minute" : "Creating…") : mode === "ai" ? "Draft my agent" : "Create agent"}
      </button>
    </form>
  );
}
