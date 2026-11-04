"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { publishVersion } from "@/app/actions";
import { diffJson, type Json } from "@/lib/diff";

interface Version { id: string; version: number; note: string; createdAt: string; config: Json }
interface LogRow { id: number; versionId: string; action: string; at: string }

const show = (v: Json | undefined) => (typeof v === "string" ? v : JSON.stringify(v));

export function VersionHistory({
  agentId, publishedId, versions, log,
}: { agentId: string; publishedId: string | null; versions: Version[]; log: LogRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState(versions[0]?.id);
  const [busy, startBusy] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const index = versions.findIndex((v) => v.id === selected);
  const current = versions[index];
  const previous = versions[index + 1]; // versions are newest first
  const changes = useMemo(
    () => (current ? diffJson(previous?.config ?? {}, current.config) : []),
    [current, previous],
  );
  const number = (id: string) => versions.find((v) => v.id === id)?.version;

  function goLive(v: Version) {
    setError(null);
    startBusy(async () => {
      const res = await publishVersion(agentId, v.id);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  if (!current) return <p className="glass p-6 text-muted">No versions yet.</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <div className="space-y-4">
        <ul className="glass divide-y divide-line overflow-hidden" aria-label="Versions">
          {versions.map((v) => (
            <li key={v.id}>
              <button
                onClick={() => setSelected(v.id)}
                aria-current={v.id === selected ? "true" : undefined}
                className={`w-full px-4 py-3 text-left transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent ${v.id === selected ? "bg-white/10" : ""}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">Version {v.version}</span>
                  {v.id === publishedId && <span className="chip chip-live">Live</span>}
                </span>
                <span className="mt-0.5 block text-xs text-faint">{new Date(v.createdAt).toLocaleString()}</span>
                {v.note && <span className="mt-1 block truncate text-sm text-muted">{v.note}</span>}
              </button>
            </li>
          ))}
        </ul>
        {log.length > 0 && (
          <section className="glass p-4" aria-label="Publish log">
            <h2 className="mb-2 text-sm font-medium">Publish log</h2>
            <ul className="space-y-1 text-xs text-muted">
              {log.map((l) => (
                <li key={l.id}>
                  {l.action === "rollback" ? "Rolled back to" : "Published"} v{number(l.versionId) ?? "?"} · {new Date(l.at).toLocaleString()}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <section className="glass p-5" aria-label={`Version ${current.version}`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">
            {previous ? `Version ${current.version} vs version ${previous.version}` : `Version ${current.version} (first version)`}
          </h2>
          {current.id === publishedId ? (
            <span className="chip chip-live">Live now</span>
          ) : (
            <button className="btn btn-primary" disabled={busy} onClick={() => goLive(current)}>
              {versions[0].id === current.id || current.version > (versions.find((v) => v.id === publishedId)?.version ?? 0)
                ? `Publish v${current.version}`
                : `Roll back to v${current.version}`}
            </button>
          )}
        </div>
        {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
        {!previous && <p className="text-sm text-muted">The starting point. Later versions show what changed from the one before.</p>}
        {previous && changes.length === 0 && <p className="text-sm text-muted">No differences.</p>}
        <ul className="space-y-3">
          {(previous ? changes : []).map((c) => (
            <li key={c.path} className="rounded-lg border border-line p-3 text-sm">
              <code className="font-mono text-xs text-faint">{c.path || "config"}</code>
              {c.kind !== "added" && (
                <p className="mt-1 whitespace-pre-wrap break-words text-danger/90"><span className="sr-only">Removed: </span>− {show(c.before)}</p>
              )}
              {c.kind !== "removed" && (
                <p className="mt-1 whitespace-pre-wrap break-words text-ok"><span className="sr-only">Added: </span>+ {show(c.after)}</p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
