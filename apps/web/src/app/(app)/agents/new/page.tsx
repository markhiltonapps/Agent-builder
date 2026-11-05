import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentClient } from "@/lib/client";
import { supabaseServer } from "@/lib/supabase/server";
import { listVotelAgents } from "@/lib/votel-import";
import { AiForm, TemplateGrid, VotelImportForm } from "./pickers";

export const metadata: Metadata = { title: "New agent" };

export default async function NewAgentPage({ searchParams }: PageProps<"/agents/new">) {
  const { tab } = await searchParams;
  const ai = tab === "ai";
  const votel = tab === "votel";
  const supabase = await supabaseServer();
  const { current } = await currentClient(supabase);
  if (!current) redirect("/agents");

  const pill = (active: boolean) =>
    `nav-pill px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent ${active ? "" : "text-muted hover:text-text"}`;

  return (
    <section aria-labelledby="new-h" className="mx-auto max-w-6xl space-y-5">
      <div>
        <Link href="/agents" className="link text-sm">← Back to agents</Link>
        <h1 id="new-h" className="mt-2 text-2xl font-semibold tracking-tight">Start a new agent</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Pick a ready-made agent for your kind of business. It already knows what to ask callers and when to bring in a
          person. You&apos;ll add your business details next, and you can change everything afterwards.
        </p>
      </div>

      <nav aria-label="How to start" className="flex gap-1">
        <Link href="/agents/new" aria-current={!ai && !votel ? "page" : undefined} className={pill(!ai && !votel)}>Ready-made agents</Link>
        <Link href="/agents/new?tab=ai" aria-current={ai ? "page" : undefined} className={pill(ai)}>Describe it and let AI draft it</Link>
        <Link href="/agents/new?tab=votel" aria-current={votel ? "page" : undefined} className={pill(votel)}>Import from Votel</Link>
      </nav>

      {ai ? <AiForm accountId={current.id} /> : votel ? <VotelTab accountId={current.id} /> : <TemplateGrid />}
    </section>
  );
}

async function VotelTab({ accountId }: { accountId: string }) {
  const found = await listVotelAgents();
  if (!found.ok) return <p role="alert" className="glass max-w-2xl p-6 text-muted">{found.error}</p>;
  if (found.agents.length === 0) return <p className="glass max-w-2xl p-6 text-muted">There are no AI agents in your Votel account yet.</p>;
  return <VotelImportForm accountId={accountId} agents={found.agents} />;
}
