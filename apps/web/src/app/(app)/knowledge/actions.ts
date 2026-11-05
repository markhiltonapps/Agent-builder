"use server";

import { revalidatePath } from "next/cache";
import { prepareDocument, prepareText } from "@/lib/knowledge";
import { supabaseServer } from "@/lib/supabase/server";

export type SaveResult = { ok: true; id: string; title: string } | { ok: false; error: string };
export type Done = { ok: true } | { ok: false; error: string };

/** The database's own messages for limits and bad input are already written for people. */
function friendly(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "42501": return "You don't have permission to change this client's knowledge.";
    case "53400":
    case "22023":
    case "P0002": return error.message;
    default: return "We couldn't save that. Try again in a moment.";
  }
}

async function save(accountId: string, docId: string | null, p: { title: string; filename: string; content: string; chunks: Array<{ heading: string; content: string }> }): Promise<SaveResult> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("knowledge_save", {
    p_account: accountId,
    p_doc: docId,
    p_title: p.title,
    p_filename: p.filename,
    p_content: p.content,
    p_agent_ids: null, // a new document is for every agent; an edited one keeps its agents
    p_chunks: p.chunks,
  });
  if (error || typeof data !== "string") return { ok: false, error: friendly(error ?? { message: "" }) };
  revalidatePath("/knowledge");
  return { ok: true, id: data, title: p.title };
}

/** One uploaded file (the page sends them one at a time, so one bad file never stops the others). */
export async function uploadKnowledgeFile(accountId: string, form: FormData): Promise<SaveResult> {
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose a file to add." };
  const prepared = prepareDocument(file.name, new Uint8Array(await file.arrayBuffer()));
  if (!prepared.ok) return prepared;
  return save(accountId, null, prepared);
}

/** A document typed or pasted in the page: new when ``docId`` is null, otherwise a replacement. */
export async function saveKnowledgeText(accountId: string, docId: string | null, title: string, text: string): Promise<SaveResult> {
  const prepared = prepareText(title, "", text);
  if (!prepared.ok) return prepared;
  return save(accountId, docId, prepared);
}

/** Which agents use a document: null means all of them. */
export async function setKnowledgeAgents(docId: string, agentIds: string[] | null): Promise<Done> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.from("knowledge_docs").update({ agent_ids: agentIds }).eq("id", docId).select("id");
  if (error || !data?.length) return { ok: false, error: "We couldn't change which agents use this document." };
  revalidatePath("/knowledge");
  return { ok: true };
}

export async function deleteKnowledge(docId: string): Promise<Done> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.from("knowledge_docs").delete().eq("id", docId).select("id");
  if (error || !data?.length) return { ok: false, error: "We couldn't delete that document." };
  revalidatePath("/knowledge");
  return { ok: true };
}
