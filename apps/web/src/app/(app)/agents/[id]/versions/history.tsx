"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { publishVersion } from "@/app/actions";
import { ChangeList } from "@/components/change-list";
import { LocalTime } from "@/components/local-time";
import { diffJson, type Json } from "@/lib/diff";

interface Version { id: string; version: number; note: string; createdAt: string; config: Json }
interface LogRow { id: number; versionId: string; action: string; at: string }

export function VersionHistory({
  agentId, publishedId, versions, log,
}: { agentId: string; publishedId: string | null; versions: Version[]; log: LogRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState(versions[0]?.id);
  const [busy, startBusy] = useTransition();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const index = versions.findIndex((v) => v.id === selected);
  const current = versions[index];
  const previous = versions[index + 1]; // versions are newest first
  const liveVersion = versions.find((v) => v.id === publishedId)?.version ?? 0;
  const changes = useMemo(
    () => (current && previous ? diffJson(previous.config, current.config) : []),
    [current, previous],
  );
  const number = (id: string) => versions.find((v) => v.id === id)?.version;

  function goLive(v: Version) {
    const rollback = v.version < liveVersion;
    const ok = window.confirm(
      `${rollback ? "Roll back to" : "Publish"} version ${v.version}?\n\nNew calls will use it. Calls already in progress aren't affected. You can switch again at any time.`,
    );
    if (!ok) return;
    setMessage(null);
    startBusy(async () => {
      const res = await publishVersion(agentId, v.id);
      if (res.error) return setMessage({ kind: "error", text: res.error });
      setMessage({ kind: "ok", text: rollback ? `Rolled back. Version ${v.version} is live now.` : `Version ${v.version} is live now.` });
      router.refresh();
    });
  }

  if (!current) return <p className="glass p-6 text-muted">No versions yet.</p>;
  const isRollback = current.version < liveVersion;

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div className="space-y-4">
        <ul className="glass divide-y divide-line overflow-hidden" aria-label="Versions">
          {versions.map((v) => (
            <li key={v.id}>
              <button
                onClick={() => setSelected(v.id)}
                aria-pressed={v.id === selected}
                className={`min-h-11 w-full border-l-2 px-4 py-3 text-left transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent ${
                  v.id === selected ? "border-accent bg-white/10" : "border-transparent"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">Version {v.version}</span>
                  {v.id === publishedId && <span className="chip chip-live">Live</span>}
                </span>
                <LocalTime iso={v.createdAt} className="block text-xs text-faint" />
                {v.note && <span className="mt-1 block truncate text-sm text-muted">{v.note}</span>}
              </button>
            </li>
          ))}
        </ul>
        {log.length > 0 && (
          <section className="glass p-4" aria-label="Publishing history">
            <h2 className="mb-2 text-sm font-medium">Publishing history</h2>
            <ul className="space-y-1 text-xs text-muted">
              {log.map((l) => (
                <li key={l.id}>
                  {l.action === "rollback" ? "Rolled back to" : "Published"} version {number(l.versionId) ?? "?"} · <LocalTime iso={l.at} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <section className="glass min-w-0 p-5" aria-label={`Version ${current.version}`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">
            {previous ? `Version ${current.version}: what changed from version ${previous.version}` : `Version ${current.version}: the starting point`}
          </h2>
          {current.id === publishedId ? (
            <span className="chip chip-live">Live now</span>
          ) : (
            <button className="btn btn-primary" disabled={busy} onClick={() => goLive(current)}>
              {busy ? "Working…" : isRollback ? `Roll back to version ${current.version}` : `Publish version ${current.version}`}
            </button>
          )}
        </div>
        <p role="status" aria-live="polite" className={`mb-3 text-sm empty:sr-only ${message?.kind === "error" ? "text-danger" : "text-ok"}`}>
          {message?.text ?? ""}
        </p>
        {!previous && <p className="text-sm text-muted">This is where the agent started. Later versions show what changed from the one before.</p>}
        {previous && changes.length === 0 && <p className="text-sm text-muted">Nothing changed from version {previous.version}.</p>}
        {previous && changes.length > 0 && <ChangeList changes={changes} />}
      </section>
    </div>
  );
}
