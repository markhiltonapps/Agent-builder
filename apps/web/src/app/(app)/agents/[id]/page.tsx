import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Editor } from "@/components/editor";
import { type AgentConfig, withDefaults } from "@/lib/config";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Edit agent" };

export default async function AgentPage({ params, searchParams }: PageProps<"/agents/[id]">) {
  const { id } = await params;
  const { copied } = await searchParams;
  const supabase = await supabaseServer();

  const { data: agent } = await supabase
    .from("agents")
    .select("id, name, account_id, published_version_id")
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

  // A saved version must at least say who answers and how. If it doesn't, say so plainly rather than crash.
  const stored = latest.config as Partial<AgentConfig> | null;
  if (!stored?.persona || !stored?.greetings) {
    return (
      <section className="glass mx-auto mt-6 max-w-xl space-y-3 p-6" role="alert">
        <h1 className="text-xl font-semibold">This agent&apos;s settings are incomplete</h1>
        <p className="text-sm text-muted">
          Version {latest.version} of {agent.name} was saved without its basic details (who answers and what they say), so it
          can&apos;t be opened for editing. Make a new agent from a ready-made template instead.
        </p>
        <Link href="/agents/new" className="btn btn-primary">Start a new agent</Link>
      </section>
    );
  }

  const { data: owner } = await supabase.from("accounts").select("name").eq("id", agent.account_id).maybeSingle();

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
      clientName={owner?.name ?? ""}
      initial={withDefaults(latest.config as Partial<AgentConfig>)}
      latest={{ id: latest.id, version: latest.version }}
      published={published}
    />
  );
}
