import { labelFor } from "@/lib/labels";
import type { Change, Json } from "@/lib/diff";

const show = (v: Json | undefined) => (typeof v === "string" ? v : JSON.stringify(v));

/** Before/after rows for a set of changes. Screen readers get "Removed:" and "Added:". */
export function ChangeList({ changes, technical = false }: { changes: Change[]; technical?: boolean }) {
  return (
    <ul className="space-y-3">
      {changes.map((c) => (
        <li key={`${c.path}-${c.kind}`} className="rounded-lg border border-line p-3 text-sm">
          <span className="text-xs font-medium text-muted">{labelFor(c.path)}</span>
          {technical && <code className="ml-2 font-mono text-xs text-faint">{c.path}</code>}
          {c.kind !== "added" && (
            <p className="mt-1 whitespace-pre-wrap break-words text-danger/90">
              <span className="sr-only">Removed: </span>− {show(c.before)}
            </p>
          )}
          {c.kind !== "removed" && (
            <p className="mt-1 whitespace-pre-wrap break-words text-ok">
              <span className="sr-only">Added: </span>+ {show(c.after)}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
