"use client";

import { useState } from "react";
import { openClient } from "@/app/actions";
import { LocalTime } from "@/components/local-time";

export interface ClientRow {
  id: string;
  name: string;
  role: string;
  agentsLive: number;
  agentsTotal: number;
  calls: number;
  minutes: number;
  /** Null when the person is not this client's owner, or the phone service could not be asked. */
  numbers: number | null;
  lastCall: string | null;
}

/** The list of clients: one row each, with a name to search, and a button that opens the client. */
export function ClientsTable({ rows }: { rows: ClientRow[] }) {
  const [q, setQ] = useState("");
  const shown = rows.filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase()));
  const open = (id: string, label: React.ReactNode, cls: string) => (
    <form action={openClient}>
      <input type="hidden" name="account_id" value={id} />
      <input type="hidden" name="to" value="/dashboard" />
      <button className={cls}>{label}</button>
    </form>
  );
  return (
    <div className="glass overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">Search clients</span>
          <input
            type="search"
            className="field !w-64 !rounded-full !py-1.5 text-sm"
            placeholder="Search clients"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <p className="text-xs text-faint" aria-live="polite">{shown.length === rows.length ? `${rows.length} ${rows.length === 1 ? "client" : "clients"}` : `${shown.length} of ${rows.length}`}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <caption className="sr-only">Your clients, with agents, calls, minutes and phone numbers for the last 30 days</caption>
          <thead className="text-faint">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Client</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Agents live</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Calls (30 days)</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Minutes (30 days)</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Phone numbers</th>
              <th scope="col" className="px-4 py-3 font-medium">Last call</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((r) => (
              <tr key={r.id} className="transition-colors hover:bg-white/5">
                <th scope="row" className="px-4 py-3 text-left font-medium">
                  {open(r.id, r.name, "link text-left font-medium")}
                  <span className="text-xs font-normal capitalize text-faint">{r.role}</span>
                </th>
                <td className="px-4 py-3 text-right tabular-nums">{r.agentsLive}<span className="text-faint"> of {r.agentsTotal}</span></td>
                <td className="px-4 py-3 text-right tabular-nums">{r.calls}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.minutes}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.numbers ?? <span className="text-faint" title="Only the owner sees phone numbers">-</span>}</td>
                <td className="px-4 py-3 text-muted">{r.lastCall ? <LocalTime iso={r.lastCall} /> : <span className="text-faint">No calls yet</span>}</td>
                <td className="px-4 py-3 text-right">{open(r.id, <>Open<span className="sr-only"> {r.name}</span></>, "btn btn-primary")}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={7} className="px-4 py-6 text-center text-muted">No client matches &ldquo;{q}&rdquo;.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
