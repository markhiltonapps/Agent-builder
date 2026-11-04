import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Json } from "@/lib/diff";
import { supabaseServer } from "@/lib/supabase/server";
import { VersionHistory } from "./history";

export const metadata: Metadata = { title: "Version history" };

export default async function VersionsPage({ params }: PageProps<"/agents/[id]/versions">) {
  const { id } = await params;
  const supabase = await supabaseServer();

  const { data: agent } = await supabase
    .from("agents")
    .select("id, name, published_version_id")
    .eq("id", id)
    .maybeSingle();
  if (!agent) notFound();

  const [{ data: versions }, { data: log }] = await Promise.all([
    supabase
      .from("agent_versions")
      .select("id, version, note, created_at, config")
      .eq("agent_id", id)
      .order("version", { ascending: false }),
    supabase
      .from("publish_log")
      .select("id, version_id, action, at")
      .eq("agent_id", id)
      .order("at", { ascending: false })
      .limit(20),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <Link href={`/agents/${id}`} className="link text-sm">← Back to editor</Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{agent.name}: version history</h1>
        <p className="mt-1 text-sm text-muted">
          Every save is kept as its own version. Rolling back makes an older version live again; nothing is deleted.
        </p>
      </div>
      <VersionHistory
        agentId={id}
        publishedId={agent.published_version_id}
        versions={(versions ?? []).map((v) => ({
          id: v.id,
          version: v.version,
          note: v.note,
          createdAt: v.created_at,
          config: v.config as Json,
        }))}
        log={(log ?? []).map((l) => ({ id: l.id, versionId: l.version_id, action: l.action, at: l.at }))}
      />
    </div>
  );
}
