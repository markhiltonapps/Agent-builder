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
    <div className="space-y-6">
      {!published && (
        <p className="max-w-2xl rounded-2xl border border-warn/40 bg-warn/10 p-3 text-sm" role="note">
          This agent isn&apos;t published yet, so visitors would hear nothing. Calls on your website always use the
          published version. <Link href={`/agents/${agentId}`} className="link">Publish it first</Link>.
        </p>
      )}

      <form className="glass max-w-2xl space-y-5 p-5" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Toggle label="Let visitors talk to this agent on my website" checked={enabled} onChange={setEnabled}
          hint="Off by default. Switch it off at any time to stop all website calls." />

        <div>
          <label htmlFor={sitesId} className="mb-1 block text-sm font-medium">Websites allowed to show it (optional)</label>
          <textarea id={sitesId} className="field min-h-24" value={sites} onChange={(e) => setSites(e.target.value)}
            placeholder={"Leave blank to allow any website"} aria-describedby={`${sitesId}-h`} spellCheck={false} />
          <p id={`${sitesId}-h`} className="hint mt-1">
            Leave this blank and your agent can be placed on any website. To lock it to your own site, list it here,
            one per line. Use <code>*.example.com</code> to include all of a site&apos;s subdomains.
          </p>
          {!sites.trim() && enabled && (
            <p className="mt-2 rounded-2xl border border-warn/40 bg-warn/10 p-3 text-xs" role="note">
              Any website can show this agent. That is easiest, but anyone could copy your code onto their page. The
              daily limit below keeps your bill safe.
            </p>
          )}
        </div>

        <div>
          <label htmlFor={limitId} className="mb-1 block text-sm font-medium">Most calls per day</label>
          <input id={limitId} type="number" inputMode="numeric" min={1} max={2000} className="field w-32" value={limit}
            onChange={(e) => setLimit(e.target.value)} aria-describedby={`${limitId}-h`} />
          <p id={`${limitId}-h`} className="hint mt-1">
            A safety cap, so a busy day or a prank can&apos;t run up your bill. A 5-minute call costs roughly 25 to 40
            cents.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
          <span role="status" aria-live="polite" className="text-sm text-ok">
            {saved && !pending && !error ? "Saved. Changes can take up to 30 seconds to reach your page." : ""}
          </span>
        </div>
        <p role="alert" className="text-sm text-danger empty:sr-only">{error ?? ""}</p>
      </form>

      {saved?.enabled ? (
        <>
          <EmbedDesigner appUrl={appUrl} agentId={agentId} />
          <p className="text-sm text-muted">
            Want to try the real thing first?{" "}
            <a href={`/embed/${agentId}`} target="_blank" rel="noreferrer" className="link">Open the call box in a new tab</a>
            . It works the same as on your site, and it starts a real call.
          </p>
        </>
      ) : (
        <p className="max-w-2xl text-sm text-muted">Switch it on and save to design your button and get your embed code.</p>
      )}
    </div>
  );
}
