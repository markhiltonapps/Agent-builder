import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isUuid } from "@/lib/embed-code";
import { supabaseServer } from "@/lib/supabase/server";
import { Editor } from "../knowledge-forms";

export const metadata: Metadata = { title: "Edit document" };

export default async function KnowledgeDocPage({ params }: PageProps<"/knowledge/[id]">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await supabaseServer();
  const { data: doc } = await supabase.from("knowledge_docs").select("id, account_id, title, content, agent_ids").eq("id", id).maybeSingle();
  if (!doc) notFound();
  const [{ data: agents }, { data: me }, { data: owner }] = await Promise.all([
    supabase.from("agents").select("id, name").eq("account_id", doc.account_id).order("name"),
    supabase.from("account_members").select("role").eq("account_id", doc.account_id),
    supabase.from("accounts").select("name").eq("id", doc.account_id).maybeSingle(),
  ]);
  const clientName = (owner?.name as string | undefined) ?? "this client";
  const canEdit = (me ?? []).some((m) => m.role === "owner" || m.role === "editor");

  return (
    <section aria-labelledby="doc-h" className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/knowledge" className="text-sm text-muted underline decoration-dotted underline-offset-4 hover:text-text">← Knowledge</Link>
        <h1 id="doc-h" className="mt-2 text-2xl font-semibold tracking-tight">{doc.title}</h1>
        <p className="mt-1 text-sm text-muted">Knowledge for {clientName}</p>
      </div>
      {canEdit ? (
        <Editor
          accountId={doc.account_id as string}
          clientName={clientName}
          docId={doc.id as string}
          initialTitle={doc.title as string}
          initialText={doc.content as string}
          agents={(agents ?? []) as Array<{ id: string; name: string }>}
          initialAgentIds={(doc.agent_ids as string[] | null) ?? null}
        />
      ) : (
        <pre className="glass whitespace-pre-wrap p-4 text-sm">{doc.content}</pre>
      )}
    </section>
  );
}
