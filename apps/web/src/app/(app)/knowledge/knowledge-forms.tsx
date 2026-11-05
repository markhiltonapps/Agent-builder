"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { askConfirm } from "@/lib/dialog";
import { ALLOWED_EXTENSIONS, fileProblem } from "@/lib/knowledge";
import { deleteKnowledge, saveKnowledgeText, setKnowledgeAgents, uploadKnowledgeFile } from "./actions";

type Outcome = { name: string; ok: boolean; message: string };

/** Choose or drop files; each is added in turn and reported on its own. */
export function UploadBox({ accountId }: { accountId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [results, setResults] = useState<Outcome[]>([]);

  async function add(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setResults([]);
    const done: Outcome[] = [];
    for (const f of files) {
      const problem = fileProblem(f.name, f.size);
      if (problem) {
        done.push({ name: f.name, ok: false, message: problem });
      } else {
        const body = new FormData();
        body.set("file", f);
        const r = await uploadKnowledgeFile(accountId, body).catch(() => ({ ok: false as const, error: "We couldn't reach the server. Try again." }));
        done.push(r.ok ? { name: f.name, ok: true, message: r.count > 1 ? `Added ${r.count} documents from ${f.name}, starting with “${r.title}”.` : `Added “${r.title}”.` } : { name: f.name, ok: false, message: r.error });
      }
      setResults([...done]);
    }
    setBusy(false);
    if (input.current) input.current.value = "";
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div
        className={`glass flex flex-col items-center gap-3 border-dashed p-6 text-center ${over ? "outline-2 outline-accent" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void add(Array.from(e.dataTransfer.files)); }}
      >
        <p className="text-sm text-muted">Drop Markdown (.md) or text (.txt) files here, or choose them. Up to 2 MB each. A long file is split into parts for you, at its headings.</p>
        <label htmlFor={id} className="btn btn-primary cursor-pointer">{busy ? "Adding…" : "Choose files"}</label>
        <input
          ref={input}
          id={id}
          type="file"
          multiple
          accept={ALLOWED_EXTENSIONS.join(",")}
          className="sr-only"
          disabled={busy}
          onChange={(e) => void add(Array.from(e.target.files ?? []))}
        />
      </div>
      <ul aria-live="polite" className="space-y-1 text-sm">
        {results.map((r, i) => (
          <li key={`${r.name}-${i}`} className={r.ok ? "text-ok" : "text-danger"}>
            <span aria-hidden>{r.ok ? "✓ " : "✗ "}</span>
            <span className="sr-only">{r.ok ? "Added: " : "Not added: "}</span>
            {r.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A document written or pasted straight into the page. */
export function WriteBox({ accountId }: { accountId: string }) {
  const router = useRouter();
  const id = useId();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const go = () =>
    start(async () => {
      setError(null);
      const r = await saveKnowledgeText(accountId, null, title, text);
      if (!r.ok) return setError(r.error);
      router.push(`/knowledge/${r.id}`);
    });

  return (
    <details className="glass p-4">
      <summary className="cursor-pointer text-sm font-medium">Or write a document here</summary>
      <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); if (!pending) go(); }}>
        <div>
          <label className="label" htmlFor={`${id}-t`}>Title</label>
          <input id={`${id}-t`} className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Opening hours" />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-b`}>Text</label>
          <textarea id={`${id}-b`} className="field min-h-48 font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder={"# Hours\n\nWe are open Monday to Friday, 8 to 5."} />
          <p className="mt-1 text-xs text-faint">Headings (lines that start with #) help the agent find the right part.</p>
        </div>
        <p role="alert" className="text-sm text-danger empty:sr-only">{error ?? ""}</p>
        <button className="btn btn-primary" disabled={pending}>{pending ? "Saving…" : "Save document"}</button>
      </form>
    </details>
  );
}

export function DeleteButton({ docId, title, redirectTo }: { docId: string; title: string; redirectTo?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (!(await askConfirm({ title: `Delete “${title}”?`, body: "Your agents will stop using it right away. This can't be undone.", confirmLabel: "Delete", tone: "danger" }))) return;
    start(async () => {
      const r = await deleteKnowledge(docId);
      if (!r.ok) return setError(r.error);
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    });
  };
  return (
    <span className="inline-flex flex-col items-start">
      <button type="button" className="btn btn-quiet btn-danger" onClick={() => void go()} disabled={pending}>
        {pending ? "Deleting…" : "Delete"}<span className="sr-only"> {title}</span>
      </button>
      <span role="alert" className="text-xs text-danger empty:sr-only">{error ?? ""}</span>
    </span>
  );
}

/** Change a document's title and text, and choose which agents use it. */
export function Editor({
  accountId, docId, initialTitle, initialText, agents, initialAgentIds,
}: {
  accountId: string; docId: string; initialTitle: string; initialText: string;
  agents: Array<{ id: string; name: string }>; initialAgentIds: string[] | null;
}) {
  const router = useRouter();
  const id = useId();
  const [title, setTitle] = useState(initialTitle);
  const [text, setText] = useState(initialText);
  const [all, setAll] = useState(initialAgentIds === null);
  const [picked, setPicked] = useState<string[]>(initialAgentIds ?? agents.map((a) => a.id));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const changed = title !== initialTitle || text !== initialText
    || all !== (initialAgentIds === null)
    || (!all && JSON.stringify([...picked].sort()) !== JSON.stringify([...(initialAgentIds ?? [])].sort()));

  const go = () =>
    start(async () => {
      setError(null);
      setNotice(null);
      if (title !== initialTitle || text !== initialText) {
        const r = await saveKnowledgeText(accountId, docId, title, text);
        if (!r.ok) return setError(r.error);
      }
      if (all !== (initialAgentIds === null) || (!all && JSON.stringify([...picked].sort()) !== JSON.stringify([...(initialAgentIds ?? [])].sort()))) {
        const r = await setKnowledgeAgents(docId, all ? null : picked);
        if (!r.ok) return setError(r.error);
      }
      setNotice("Saved. Your agents use it from the next call or chat.");
      router.refresh();
    });

  return (
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); if (!pending) go(); }}>
      <div>
        <label className="label" htmlFor={`${id}-t`}>Title</label>
        <input id={`${id}-t`} className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </div>
      <div>
        <label className="label" htmlFor={`${id}-b`}>Text (Markdown)</label>
        <textarea id={`${id}-b`} className="field min-h-[24rem] font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} spellCheck />
      </div>
      <fieldset className="space-y-2">
        <legend className="label">Which agents use this?</legend>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="radio" name={`${id}-scope`} className="size-4" checked={all} onChange={() => setAll(true)} />
          Every agent for this client
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="radio" name={`${id}-scope`} className="size-4" checked={!all} onChange={() => setAll(false)} />
          Only the ones I choose
        </label>
        {!all && (
          <ul className="ml-6 space-y-1">
            {agents.map((a) => (
              <li key={a.id}>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={picked.includes(a.id)}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))}
                  />
                  {a.name}
                </label>
              </li>
            ))}
            {!agents.length && <li className="text-sm text-muted">This client has no agents yet.</li>}
          </ul>
        )}
      </fieldset>
      <p role="alert" className="text-sm text-danger empty:sr-only">{error ?? ""}</p>
      <p role="status" className="text-sm text-ok empty:sr-only">{notice ?? ""}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending || !changed}>{pending ? "Saving…" : "Save changes"}</button>
        <Link href="/knowledge" className="btn">Back to Knowledge</Link>
        <span className="ml-auto"><DeleteButton docId={docId} title={initialTitle} redirectTo="/knowledge" /></span>
      </div>
    </form>
  );
}
