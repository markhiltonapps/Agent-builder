"use client";

import { askConfirm, fromText } from "@/lib/dialog";
import { useActionState, useId, useState, useTransition } from "react";
import { changeNumberAgent, releaseNumber, rentNumber, searchNumbers, type Done } from "@/app/numbers-actions";
import { formatNumber } from "@/lib/phone-format";

interface Agent { id: string; name: string }
interface Owned { e164: string; status: string; agentId: string | null; agentName: string | null }

export function NumbersPanel({ owned, agents }: { owned: Owned[]; agents: Agent[] }) {
  const [state, search, searching] = useActionState(searchNumbers, undefined);
  const [result, setResult] = useState<Done | null>(null);
  const [busy, startBusy] = useTransition();
  const [pick, setPick] = useState(agents[0]?.id ?? "");
  const areaId = useId();
  const digitsId = useId();
  const whereId = useId();
  const agentId = useId();

  const run = async (confirmText: string, job: () => Promise<Done>, danger = false) => {
    const ok = await askConfirm(fromText(confirmText, { tone: danger ? "danger" : "default", confirmLabel: danger ? "Release it" : "Yes, do it" }));
    if (!ok) return;
    setResult(null);
    startBusy(async () => setResult(await job()));
  };

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "this agent";

  return (
    <div className="space-y-4">
      <p role="status" aria-live="polite" className={`text-sm empty:sr-only ${result && !result.ok ? "text-danger" : "text-ok"}`}>
        {result ? (result.ok ? result.message : result.error) : ""}
      </p>

      <section className="glass p-5" aria-labelledby="mine-h">
        <h2 id="mine-h" className="mb-3 text-lg font-semibold">Your numbers</h2>
        {owned.length === 0 ? (
          <p className="text-sm text-muted">You don&apos;t have a number yet. Search for one below.</p>
        ) : (
          <ul className="space-y-3">
            {owned.map((n) => (
              <li key={n.e164} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line p-3">
                <div className="min-w-0">
                  <p className="font-medium tabular-nums">{formatNumber(n.e164)}</p>
                  <p className="text-sm text-muted">
                    {n.agentName ? <>Answered by <strong className="font-medium text-text">{n.agentName}</strong></> : "Not answered by any agent yet"}
                    {n.status && n.status !== "active" ? ` · ${n.status}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {agents.length > 0 && (
                    <select
                      aria-label={`Agent that answers ${formatNumber(n.e164)}`} className="field w-auto" disabled={busy}
                      value={n.agentId ?? ""}
                      onChange={(e) => run(`Make ${agentName(e.target.value)} answer ${formatNumber(n.e164)}?`, () => changeNumberAgent(n.e164, e.target.value))}
                    >
                      {!n.agentId && <option value="" disabled>Choose an agent…</option>}
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  )}
                  <button
                    className="btn btn-quiet btn-danger" disabled={busy}
                    onClick={() => run(`Release ${formatNumber(n.e164)}?\n\nCallers will no longer reach your agent on this number, and you stop paying for it. You may not get the same number back.`, () => releaseNumber(n.e164), true)}
                  >
                    Release
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="glass p-5" aria-labelledby="get-h">
        <h2 id="get-h" className="mb-1 text-lg font-semibold">Get a number</h2>
        <p className="mb-4 text-sm text-muted">
          US local numbers only, for incoming calls. LiveKit&apos;s price: your first number is free, then $1.00 a month each,
          plus about 1 cent a minute for calls after a small free allowance. You can release a number any time to stop paying.
        </p>
        {agents.length === 0 ? (
          <p className="text-sm text-muted">Publish an agent first. A number rings the published version of an agent.</p>
        ) : (
          <>
            <form action={search} className="space-y-3">
              <div className="flex flex-wrap items-start gap-3">
                <div>
                  <label className="label" htmlFor={areaId}>Area code</label>
                  <input id={areaId} name="area" inputMode="numeric" maxLength={20} placeholder="602" required className="field w-40" defaultValue={state?.area} aria-describedby={`${areaId}-h`} />
                  <p id={`${areaId}-h`} className="hint max-w-[11rem]">Add up to three, like 602, 480.</p>
                </div>
                <div>
                  <label className="label" htmlFor={digitsId}>Digits you want (optional)</label>
                  <input id={digitsId} name="digits" inputMode="numeric" maxLength={7} placeholder="7777" className="field w-36" defaultValue={state?.digits} aria-describedby={`${digitsId}-h`} />
                  <p id={`${digitsId}-h`} className="hint max-w-[11rem]">Like 7777 or 1234.</p>
                </div>
                <div>
                  <label className="label" htmlFor={whereId}>Where in the number</label>
                  <select id={whereId} name="where" className="field w-40" defaultValue={state?.where ?? "anywhere"}>
                    <option value="anywhere">Anywhere</option>
                    <option value="end">At the end</option>
                    <option value="start">At the start</option>
                  </select>
                </div>
              </div>
              <button className="btn" disabled={searching}>{searching ? "Searching…" : "Search"}</button>
            </form>
            <p role="alert" className="mt-3 text-sm text-danger empty:sr-only">{state?.error ?? ""}</p>

            {state?.results && (
              <div className="mt-4 space-y-3">
                <div>
                  <label className="label" htmlFor={agentId}>Which agent should answer it?</label>
                  <select id={agentId} className="field w-full sm:w-72" value={pick} onChange={(e) => setPick(e.target.value)}>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <ul className="space-y-2" aria-label="Available numbers">
                  {state.results.map((r) => (
                    <li key={r.e164} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line p-3">
                      <span>
                        <span className="font-medium tabular-nums">{formatNumber(r.e164)}</span>
                        {r.place && <span className="ml-2 text-sm text-muted">{r.place}</span>}
                      </span>
                      <button
                        className="btn" disabled={busy || !pick}
                        onClick={() => run(
                          `Rent ${formatNumber(r.e164)} for ${agentName(pick)}?\n\nLiveKit charges $1.00 a month for each US local number after your first free one, plus about 1 cent a minute for calls after a small free allowance. You can release it any time.`,
                          () => rentNumber(r.e164, pick),
                        )}
                      >
                        {busy ? "Working…" : "Rent this number"}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
