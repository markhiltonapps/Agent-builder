"use client";

import { useActionState, useId, useState, useTransition } from "react";
import { addClient, setClientShare } from "@/app/actions";
import { askConfirm } from "@/lib/dialog";

export function AddClientForm() {
  const [state, action, pending] = useActionState(addClient, undefined);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="min-w-0 flex-1">
        <label className="label" htmlFor="client-name">Client name</label>
        <input id="client-name" name="name" required maxLength={200} className="field" placeholder="e.g. Bright Smile Dental" />
      </div>
      <button className="btn btn-primary" disabled={pending}>{pending ? "Adding…" : "Add client"}</button>
      <p role="alert" className="basis-full text-sm text-danger empty:sr-only">{state?.error}</p>
    </form>
  );
}

/** The client's private, read-only dashboard link: turn it on, copy it, replace it, or turn it off. */
export function ShareControl({ accountId, initialToken, appUrl }: { accountId: string; initialToken: string | null; appUrl: string }) {
  const [token, setToken] = useState(initialToken);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const id = useId();
  const url = token ? `${appUrl}/share/${token}` : "";

  const run = (enabled: boolean, rotate = false) =>
    start(async () => {
      setError(null);
      const r = await setClientShare(accountId, enabled, rotate);
      if (!r.ok) return setError(r.error);
      setToken(r.token);
    });

  return (
    <div className="space-y-2 border-t border-line pt-4">
      <h3 className="text-sm font-medium">Dashboard link for this client</h3>
      {token ? (
        <>
          <label htmlFor={id} className="sr-only">Private dashboard link</label>
          <input id={id} readOnly value={url} className="field text-xs" onFocus={(e) => e.currentTarget.select()} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn" onClick={async () => {
              try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* select by hand */ }
            }}>Copy link</button>
            <button type="button" className="btn btn-quiet" disabled={pending} onClick={async () => {
              const ok = await askConfirm({ title: "Replace this link?", body: "The old link stops working right away. Anyone you sent it to will need the new one.", confirmLabel: "Replace link", tone: "danger" });
              if (ok) run(true, true);
            }}>Replace link</button>
            <button type="button" className="btn btn-quiet btn-danger" disabled={pending} onClick={async () => {
              const ok = await askConfirm({ title: "Turn off this link?", body: "Anyone using it will no longer be able to see the dashboard. You can turn it back on later, with a new link.", confirmLabel: "Turn it off", tone: "danger" });
              if (ok) run(false);
            }}>Turn off</button>
            <span role="status" aria-live="polite" className="text-sm text-ok">{copied ? "Copied" : ""}</span>
          </div>
          <p className="text-xs text-faint">Anyone with this link can see call numbers for this client. It shows no transcripts, summaries or phone numbers.</p>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">Give this client a private link to their own dashboard: calls, goals reached and how each agent is doing.</p>
          <button type="button" className="btn" disabled={pending} onClick={() => run(true)}>{pending ? "Creating…" : "Create dashboard link"}</button>
        </>
      )}
      <p role="alert" className="text-sm text-danger empty:sr-only">{error ?? ""}</p>
    </div>
  );
}
