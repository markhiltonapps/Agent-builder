"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";
import { createAgent } from "@/app/actions";
import { LIBRARY } from "@/lib/template-library";

export function TemplateGrid() {
  const [q, setQ] = useState("");
  const id = useId();
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? LIBRARY.filter((t) => `${t.label} ${t.blurb} ${t.handles.join(" ")}`.toLowerCase().includes(needle))
    : LIBRARY;
  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <label htmlFor={id} className="sr-only">Search ready-made agents</label>
        <input id={id} type="search" className="field" placeholder={`Search ${LIBRARY.length} kinds of business`} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <p role="status" aria-live="polite" className="text-sm text-muted">
        {needle ? `${shown.length} ${shown.length === 1 ? "match" : "matches"}` : `${LIBRARY.length} ready-made agents`}
      </p>
      {shown.length === 0 ? (
        <p className="glass p-6 text-muted">
          Nothing matches “{q}”. Try a broader word, or start from the{" "}
          <Link href="/agents/new/general" className="link">General receptionist</Link>.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((t) => (
            <li key={t.key}>
              <Link
                href={`/agents/new/${t.key}`}
                className="glass group flex h-full flex-col gap-3 p-5 transition-colors hover:bg-white/[0.09] focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className="flex items-center gap-3">
                  <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/10 text-2xl">{t.icon}</span>
                  <span className="font-medium leading-tight">{t.label}</span>
                </span>
                <span className="text-sm text-muted">{t.blurb}</span>
                <span className="mt-auto flex flex-wrap gap-1.5 pt-1">
                  <span className="chip">Takes messages</span>
                  {t.handsOff && <span className="chip">Flags urgent calls</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AiForm({ accountId }: { accountId: string }) {
  const [state, action, pending] = useActionState(createAgent, undefined);
  return (
    <form action={action} className="glass max-w-2xl space-y-4 p-5" aria-busy={pending}>
      <input type="hidden" name="account_id" value={accountId} />
      <div>
        <label className="label" htmlFor="agent-name">Agent name</label>
        <input id="agent-name" name="name" required maxLength={200} placeholder="e.g. Weekend receptionist" className="field" />
      </div>
      <div>
        <label className="label" htmlFor="description">About the business</label>
        <textarea
          id="description" name="description" rows={6} maxLength={4000} required className="field"
          aria-describedby="description-hint"
          placeholder="For example: Bright Smile Dental in Scottsdale, open Monday to Thursday 8 to 5. Callers mostly want to book a cleaning, ask about insurance, or report a toothache."
        />
        <p id="description-hint" className="hint">What it does, when it&apos;s open, who calls and why. Don&apos;t include prices unless you want the agent to quote them.</p>
      </div>
      <p role="status" aria-live="polite" className="text-sm text-muted empty:sr-only">
        {pending ? "Drafting your agent. This can take up to a minute." : ""}
      </p>
      <p role="alert" className="text-sm text-danger empty:sr-only">{state?.error}</p>
      <button className="btn btn-primary" disabled={pending}>{pending ? "Drafting… this can take up to a minute" : "Draft my agent"}</button>
    </form>
  );
}
