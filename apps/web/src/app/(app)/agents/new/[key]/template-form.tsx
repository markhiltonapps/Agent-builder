"use client";

import { useActionState } from "react";
import { createAgentFromTemplate } from "@/app/actions";
import { DEFAULT_TIME_ZONE, TIME_ZONES } from "@/lib/template-library";

export function TemplateForm({
  accountId, templateKey, defaultName, defaultDescription,
}: { accountId: string; templateKey: string; defaultName: string; defaultDescription: string }) {
  const [state, action, pending] = useActionState(createAgentFromTemplate, undefined);
  return (
    <form action={action} className="space-y-4" aria-busy={pending}>
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="template" value={templateKey} />
      <div>
        <label className="label" htmlFor="business">Business name</label>
        <input id="business" name="business_name" required maxLength={200} autoComplete="organization" className="field"
          placeholder="e.g. Bright Smile Dental" aria-describedby="business-h" />
        <p id="business-h" className="hint">The agent says this when it answers.</p>
      </div>
      <div>
        <label className="label" htmlFor="about">About the business</label>
        <textarea id="about" name="description" rows={5} maxLength={1000} className="field" defaultValue={defaultDescription} aria-describedby="about-h" />
        <p id="about-h" className="hint">Add what you want callers to hear: where you are, what you offer, when you&apos;re open. The agent only says what&apos;s written here.</p>
      </div>
      <div>
        <label className="label" htmlFor="tz">Time zone</label>
        <select id="tz" name="timezone" className="field" defaultValue={DEFAULT_TIME_ZONE}>
          {TIME_ZONES.map((z) => <option key={z.value} value={z.value}>{z.label}</option>)}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="agent-name">Name for this agent</label>
        <input id="agent-name" name="name" required maxLength={200} className="field" defaultValue={defaultName} aria-describedby="name-h" />
        <p id="name-h" className="hint">Only you see this, in your list of agents.</p>
      </div>
      <p id="create-error" role="alert" className="text-sm text-danger empty:sr-only">{state?.error}</p>
      <button className="btn btn-primary w-full" disabled={pending}>{pending ? "Creating…" : "Create agent and open it"}</button>
      <p className="text-xs text-faint">Nothing goes live until you publish it. You can test it with a call first.</p>
    </form>
  );
}
