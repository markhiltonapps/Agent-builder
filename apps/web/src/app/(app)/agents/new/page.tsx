import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { AiForm, TemplateGrid } from "./pickers";

export const metadata: Metadata = { title: "New agent" };

export default async function NewAgentPage({ searchParams }: PageProps<"/agents/new">) {
  const { tab } = await searchParams;
  const ai = tab === "ai";
  const supabase = await supabaseServer();
  const { data: accounts } = await supabase.from("accounts").select("id").order("created_at").limit(1);
  if (!accounts?.length) redirect("/agents");

  const pill = (active: boolean) =>
    `rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
      active ? "bg-white/10 text-text" : "text-muted hover:text-text"
    }`;

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
        <Link href="/agents/new" aria-current={!ai ? "page" : undefined} className={pill(!ai)}>Ready-made agents</Link>
        <Link href="/agents/new?tab=ai" aria-current={ai ? "page" : undefined} className={pill(ai)}>Describe it and let AI draft it</Link>
      </nav>

      {ai ? <AiForm accountId={accounts[0].id} /> : <TemplateGrid />}
    </section>
  );
}
