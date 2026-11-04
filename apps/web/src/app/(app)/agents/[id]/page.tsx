import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Editor } from "@/components/editor";
import type { AgentConfig } from "@/lib/config";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Edit agent" };

export default async function AgentPage({ params, searchParams }: PageProps<"/agents/[id]">) {
  const { id } = await params;
  const { copied } = await searchParams;
  const supabase = await supabaseServer();

  const { data: agent } = await supabase
    .from("agents")
    .select("id, name, published_version_id")
    .eq("id", id)
    .maybeSingle();
  if (!agent) notFound();

  const { data: latest } = await supabase
    .from("agent_versions")
    .select("id, version, config")
    .eq("agent_id", id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) notFound();

  let published: { id: string; version: number } | null = null;
  if (agent.published_version_id) {
    const { data } = await supabase
      .from("agent_versions")
      .select("id, version")
      .eq("id", agent.published_version_id)
      .maybeSingle();
    published = data;
  }

  return (
    <Editor
      notice={copied ? "Copy created. You're editing it now." : undefined}
      agent={{ id: agent.id, name: agent.name }}
      initial={latest.config as AgentConfig}
      latest={{ id: latest.id, version: latest.version }}
      published={published}
    />
  );
}
