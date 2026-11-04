import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { CallPanel } from "./call-panel";

export const metadata: Metadata = { title: "Talk to your agent" };

export default async function TalkPage({ params }: PageProps<"/agents/[id]/talk">) {
  const { id } = await params;
  const supabase = await supabaseServer();
  const { data: agent } = await supabase
    .from("agents")
    .select("id, name, published_version_id")
    .eq("id", id)
    .maybeSingle();
  if (!agent) notFound();

  let version: number | null = null;
  if (agent.published_version_id) {
    const { data } = await supabase
      .from("agent_versions")
      .select("version")
      .eq("id", agent.published_version_id)
      .maybeSingle();
    version = data?.version ?? null;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href={`/agents/${id}`} className="link text-sm">← Back to editor</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Talk to {agent.name}</h1>
      <CallPanel agentId={agent.id} agentName={agent.name} liveVersion={version} />
    </div>
  );
}
