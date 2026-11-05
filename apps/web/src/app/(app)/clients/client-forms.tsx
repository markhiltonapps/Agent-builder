"use client";

import { useActionState, useId, useRef, useState, useTransition } from "react";
import { addClient, addClientFromVotel, loadVotelClients, removeClient, removeVotelContact, sendClientToVotel, setClientShare, unlinkClientFromVotel, type VotelRemoval } from "@/app/actions";
import type { VotelClient } from "@/lib/votel-clients";
import { askConfirm } from "@/lib/dialog";

export function AddClientForm() {
  const [state, action, pending] = useActionState(addClient, undefined);
  const [toVotel, setToVotel] = useState(true);
  return (
    <form action={action} className="grid gap-3" aria-busy={pending}>
      <div>
        <label className="label" htmlFor="client-name">Client name</label>
        <input id="client-name" name="name" required maxLength={200} className="field" placeholder="e.g. Bright Smile Dental" />
      </div>
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input type="checkbox" name="to_votel" checked={toVotel} onChange={(e) => setToVotel(e.target.checked)} className="mt-0.5 size-5 shrink-0" />
        <span>
          Also add this client to Votel
          <span className="hint block">Creates a contact there with the tag <code>agent-builder-client</code>, or finds the one with the same email or phone.</span>
        </span>
      </label>
      {toVotel && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="client-email">Contact email (optional)</label>
            <input id="client-email" name="email" type="email" maxLength={200} className="field" placeholder="owner@business.com" />
          </div>
          <div>
            <label className="label" htmlFor="client-phone">Contact phone (optional)</label>
            <input id="client-phone" name="phone" type="tel" maxLength={40} className="field" placeholder="(512) 555-0100" />
          </div>
        </div>
      )}
      <div><button className="btn btn-primary" disabled={pending}>{pending ? "Adding…" : "Add client"}</button></div>
      <p role="alert" className="text-sm text-danger empty:sr-only">{state?.error}</p>
    </form>
  );
}

/** Bring clients over from Votel: contacts there that carry the client tag. */
export function VotelPicker() {
  const [found, setFound] = useState<{ clients: VotelClient[]; tag: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const check = () =>
    start(async () => {
      setError(null);
      setDone(null);
      const r = await loadVotelClients();
      if (r.ok) setFound({ clients: r.clients, tag: r.tag });
      else setError(r.error);
    });

  const add = (c: VotelClient) =>
    start(async () => {
      setError(null);
      setBusy(c.id);
      const r = await addClientFromVotel(c.id);
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setDone(`${r.name} is now a client here.`);
      setFound((f) => (f ? { ...f, clients: f.clients.filter((x) => x.id !== c.id) } : f));
    });

  const drop = async (c: VotelClient, mode: "untag" | "delete") => {
    const ok = await askConfirm(
      mode === "delete"
        ? { title: `Delete ${c.name} in Votel?`, body: "This deletes the contact in Votel. Votel keeps deleted contacts so they can be recovered, but they disappear from your lists.", confirmLabel: "Delete contact", tone: "danger" }
        : { title: `Take ${c.name} off the client list?`, body: "This only removes the agent-builder-client tag in Votel. The contact and its history stay.", confirmLabel: "Remove tag" },
    );
    if (!ok) return;
    start(async () => {
      setError(null);
      setBusy(c.id);
      const r = await removeVotelContact(c.id, mode);
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setDone(mode === "delete" ? `${c.name} was deleted in Votel.` : `${c.name} is off the client list.`);
      setFound((f) => (f ? { ...f, clients: f.clients.filter((x) => x.id !== c.id) } : f));
    });
  };

  return (
    <div className="space-y-3">
      <button type="button" className="btn" disabled={pending} onClick={check}>
        {pending && !busy ? "Checking Votel…" : found ? "Check Votel again" : "Check Votel for clients"}
      </button>
      {found && (
        found.clients.length ? (
          <ul className="space-y-2" aria-label="Clients found in Votel">
            {found.clients.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-xs text-faint">{[c.email, c.phone].filter(Boolean).join(" · ") || "No email or phone"}</span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <button type="button" className="btn" disabled={pending} onClick={() => add(c)}>{busy === c.id ? "Adding…" : "Add as client"}</button>
                  <button type="button" className="btn btn-quiet" disabled={pending} onClick={() => drop(c, "untag")}>Remove tag</button>
                  <button type="button" className="btn btn-quiet btn-danger" disabled={pending} onClick={() => drop(c, "delete")}>Delete in Votel</button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No new clients found. In Votel, add the tag <code>{found.tag}</code> to a contact and check again.</p>
        )
      )}
      <p role="status" aria-live="polite" className="text-sm text-ok empty:sr-only">{done ?? ""}</p>
      <p role="alert" className="text-sm text-danger empty:sr-only">{error ?? ""}</p>
    </div>
  );
}

/** Shows whether this client is linked to a Votel contact, and links or unlinks it. */
export function VotelLink({ accountId, linked }: { accountId: string; linked: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => start(async () => { setError(null); const r = await fn(); if (!r.ok) setError(r.error ?? "That didn't work. Try again."); });
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <h3 className="text-sm font-medium">Votel</h3>
      {linked ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip chip-live">Linked to a Votel contact</span>
          <button type="button" className="btn btn-quiet" disabled={pending} onClick={async () => {
            const ok = await askConfirm({ title: "Unlink from Votel?", body: "This client stays here, and its contact stays in Votel. They just stop being matched, so new calls and agent cards won't be filed on that contact.", confirmLabel: "Unlink" });
            if (ok) run(() => unlinkClientFromVotel(accountId));
          }}>Unlink</button>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted">Not in Votel yet. Send it there to make a contact tagged <code>agent-builder-client</code>, and file its calls and agent cards on that contact.</p>
          <button type="button" className="btn" disabled={pending} onClick={() => run(() => sendClientToVotel(accountId))}>{pending ? "Sending…" : "Send to Votel"}</button>
        </>
      )}
      <p role="alert" className="text-sm text-danger empty:sr-only">{error ?? ""}</p>
    </div>
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

/** Remove a client for good, with a choice about its Votel contact and the client's name typed to confirm. */
export function RemoveClient({ accountId, name, linked }: { accountId: string; name: string; linked: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<VotelRemoval>("untag");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const id = useId();
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();

  const open = () => { setTyped(""); setError(null); ref.current?.showModal(); };
  const close = () => ref.current?.close();
  const go = () =>
    start(async () => {
      setError(null);
      const r = await removeClient(accountId, linked ? mode : "keep", typed);
      if (!r.ok) return setError(r.error);
      close();
    });

  return (
    <div className="border-t border-line pt-4">
      <button type="button" className="btn btn-quiet btn-danger" onClick={open}>Remove client</button>
      <dialog ref={ref} className="glass-dialog" aria-labelledby={`${id}-t`} onCancel={(e) => { if (pending) e.preventDefault(); }}>
        <form className="glass space-y-4 p-6" onSubmit={(e) => { e.preventDefault(); if (matches && !pending) go(); }}>
          <h2 id={`${id}-t`} className="text-lg font-semibold tracking-tight">Remove {name}?</h2>
          <p className="text-sm text-muted">This permanently deletes the client here: its agents, calls and settings. It cannot be undone, so download its usage first if you need it for billing.</p>
          {linked && (
            <fieldset className="space-y-1">
              <legend className="label">What about its contact in Votel?</legend>
              {([["keep", "Leave it as it is"], ["untag", "Take off the agent-builder-client tag (keeps the contact and its history)"], ["delete", "Delete the contact in Votel (Votel can recover it)"]] as const).map(([v, label]) => (
                <label key={v} className="flex cursor-pointer items-start gap-2 py-0.5 text-sm">
                  <input type="radio" name={`${id}-votel`} value={v} checked={mode === v} onChange={() => setMode(v)} className="mt-0.5 size-4" />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div>
            <label className="label" htmlFor={`${id}-n`}>Type <strong>{name}</strong> to confirm</label>
            <input id={`${id}-n`} className="field" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          <p role="alert" className="text-sm text-danger empty:sr-only">{error ?? ""}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn" onClick={close} disabled={pending}>Cancel</button>
            <button className="btn btn-danger" disabled={!matches || pending}>{pending ? "Removing…" : "Remove client"}</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
