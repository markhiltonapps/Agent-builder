import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { currentClient } from "@/lib/client";
import { scopeLabel, sizeLabel } from "@/lib/knowledge";
import { supabaseServer } from "@/lib/supabase/server";
import { DeleteButton, UploadBox, WriteBox } from "./knowledge-forms";

export const metadata: Metadata = { title: "Knowledge" };

export default async function KnowledgePage() {
  const supabase = await supabaseServer();
  const { current } = await currentClient(supabase);
  if (!current) {
    return <p className="mx-auto mt-10 max-w-lg text-sm text-muted">Add a client first, then come back to give its agents knowledge.</p>;
  }
  const [{ data: docs }, { data: agents }, { data: me }] = await Promise.all([
    supabase.from("knowledge_docs").select("id, title, filename, chars, agent_ids, updated_at").eq("account_id", current.id).order("updated_at", { ascending: false }),
    supabase.from("agents").select("id, name").eq("account_id", current.id).order("name"),
    supabase.from("account_members").select("role").eq("account_id", current.id),
  ]);
  const canEdit = (me ?? []).some((m) => m.role === "owner" || m.role === "editor");
  const list = docs ?? [];
  const total = list.reduce((n, d) => n + (d.chars as number), 0);

  return (
    <section aria-labelledby="kb-h" className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 id="kb-h" className="text-2xl font-semibold tracking-tight">Knowledge</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Give {current.name}&apos;s agents the facts they need: prices, hours, services, policies, answers to common questions.
          Upload Markdown or text files and the agents answer from them, on calls and in chat. Changes apply to the next call or chat,
          with nothing to publish.
        </p>
        <p role="note" className="mt-3 max-w-2xl rounded-2xl border border-accent/30 bg-accent/10 p-3 text-sm leading-relaxed text-text">
          You are adding knowledge for <strong className="font-medium">{current.name}</strong>. Only {current.name}&apos;s agents
          ({(agents ?? []).length ? (agents ?? []).map((a) => a.name).join(", ") : "none yet"}) can use it, and no other client&apos;s
          agent ever sees it. To add knowledge for a different client, choose that client in the <strong className="font-medium">Client</strong> menu at
          the top. To keep a document to one of {current.name}&apos;s agents, open it and choose <strong className="font-medium">Only the ones I choose</strong>.
        </p>
      </div>

      {canEdit ? (
        <>
          <UploadBox accountId={current.id} />
          <WriteBox accountId={current.id} />
        </>
      ) : (
        <p className="text-sm text-muted">You can read this client&apos;s knowledge. Ask an owner or editor to change it.</p>
      )}

      <div>
        <h2 className="mb-2 text-lg font-medium">
          Documents <span className="text-sm font-normal text-faint">({list.length}{list.length ? `, ${sizeLabel(total)} in all` : ""})</span>
        </h2>
        {list.length ? (
          <ul className="space-y-2">
            {list.map((d) => (
              <li key={d.id} className="glass flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <Link href={`/knowledge/${d.id}`} className="block truncate font-medium hover:underline focus-visible:outline-2 focus-visible:outline-accent">{d.title}</Link>
                  <p className="text-xs text-faint">
                    {d.filename ? `${d.filename} · ` : ""}{sizeLabel(d.chars as number)} · Edited <LocalTime iso={d.updated_at as string} />
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip whitespace-nowrap">{scopeLabel(d.agent_ids as string[] | null, agents ?? [], current.name)}</span>
                  {canEdit && <Link href={`/knowledge/${d.id}`} className="btn">Edit<span className="sr-only"> {d.title}</span></Link>}
                  {canEdit && <DeleteButton docId={d.id as string} title={d.title as string} />}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="glass p-5 text-sm text-muted">
            Nothing here yet. Start with the questions callers ask most: your hours, prices, services, location and policies.
          </p>
        )}
      </div>
    </section>
  );
}
