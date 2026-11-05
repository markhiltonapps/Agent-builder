"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { saveEmbed } from "@/app/actions";
import { Toggle } from "@/components/fields";
import { EmbedDesigner } from "./embed-designer";

export function EmbedForm({
  agentId, appUrl, published, initial,
}: { agentId: string; appUrl: string; published: boolean; initial: { enabled: boolean; sites: string[]; limit: number } }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [sites, setSites] = useState(initial.sites.join("\n"));
  const [limit, setLimit] = useState(String(initial.limit));
  const [saved, setSaved] = useState<{ enabled: boolean } | null>(initial.enabled ? { enabled: true } : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const sitesId = useId();
  const limitId = useId();

  function save() {
    setError(null);
    start(async () => {
      const r = await saveEmbed(agentId, enabled, sites, Number(limit));
      if (!r.ok) return setError(r.error);
      setSites(r.sites.join("\n"));
      setSaved({ enabled });
    });
  }

  return (
    <div className="space-y-4">
      {!published && (
        <p className="rounded-2xl border border-warn/40 bg-warn/10 p-3 text-sm" role="note">
          This agent isn&apos;t published yet, so visitors would hear nothing. Calls on your website always use the
          published version. <Link href={`/agents/${agentId}`} className="link">Publish it first</Link>.
        </p>
      )}

      <details open={!initial.enabled} className="glass group p-4 sm:p-5">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-lg focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          <span className={`size-2.5 rounded-full ${saved?.enabled ? "bg-ok" : "bg-faint"}`} aria-hidden />
          <span className="font-medium">Website calls: {saved?.enabled ? "On" : "Off"}</span>
          <span className="text-sm text-muted">
            {saved?.enabled ? `${sites.trim() ? sites.trim().split(/\n+/).slice(0, 2).join(", ") : "any website"} · up to ${limit} calls a day` : "Switch on to get your code"}
          </span>
          <span className="ml-auto text-sm text-accent group-open:hidden">Change</span>
          <span className="ml-auto hidden text-sm text-accent group-open:inline">Hide</span>
        </summary>

        <form className="mt-4 grid gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div>
            <Toggle label="Let visitors talk to this agent on my website" checked={enabled} onChange={setEnabled}
              hint="Off by default. Switch it off at any time to stop all website calls." />
          </div>

          <div>
            <label htmlFor={sitesId} className="mb-1 block text-sm font-medium">Websites allowed to show it (optional)</label>
            <textarea id={sitesId} className="field min-h-16" rows={2} value={sites} onChange={(e) => setSites(e.target.value)}
              placeholder={"Leave blank to allow any website"} aria-describedby={`${sitesId}-h`} spellCheck={false} />
            <p id={`${sitesId}-h`} className="hint mt-1">
              One per line. Use <code>*.example.com</code> to include subdomains. Blank allows any website.
            </p>
            {!sites.trim() && enabled && (
              <p className="mt-2 rounded-2xl border border-warn/40 bg-warn/10 p-2.5 text-xs" role="note">
                Any website can show this agent, and anyone could copy your code. The daily limit keeps your bill safe.
              </p>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <label htmlFor={limitId} className="mb-1 block text-sm font-medium">Most calls per day</label>
              <input id={limitId} type="number" inputMode="numeric" min={1} max={2000} className="field w-32" value={limit}
                onChange={(e) => setLimit(e.target.value)} aria-describedby={`${limitId}-h`} />
              <p id={`${limitId}-h`} className="hint mt-1 max-w-[15rem]">
                A safety cap. A 5-minute call costs roughly 25 to 40 cents.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn btn-primary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
              <span role="status" aria-live="polite" className="text-sm text-ok">
                {saved && !pending && !error ? "Saved. Allow up to 30 seconds." : ""}
              </span>
            </div>
          </div>
          <p role="alert" className="text-sm text-danger empty:sr-only lg:col-span-3">{error ?? ""}</p>
        </form>
      </details>

      {saved?.enabled ? (
        <EmbedDesigner appUrl={appUrl} agentId={agentId} />
      ) : (
        <p className="max-w-2xl text-sm text-muted">Switch it on and save to design your button, try it, and get your embed code.</p>
      )}
    </div>
  );
}
