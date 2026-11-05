import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { findTemplate, handoffLines, neverLines } from "@/lib/template-library";
import { supabaseServer } from "@/lib/supabase/server";
import { TemplateForm } from "./template-form";

export async function generateMetadata({ params }: PageProps<"/agents/new/[key]">): Promise<Metadata> {
  const t = findTemplate((await params).key);
  return { title: t ? `${t.label} agent` : "New agent" };
}

export default async function TemplatePage({ params }: PageProps<"/agents/new/[key]">) {
  const t = findTemplate((await params).key);
  if (!t) notFound();
  const supabase = await supabaseServer();
  const { data: accounts } = await supabase.from("accounts").select("id").order("created_at").limit(1);
  if (!accounts?.length) redirect("/agents");

  const handoffs = handoffLines(t.config);
  const nevers = neverLines(t.config);
  return (
    <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <section aria-labelledby="t-h" className="space-y-6">
        <div>
          <Link href="/agents/new" className="link text-sm">← All ready-made agents</Link>
          <div className="mt-3 flex items-center gap-4">
            <span aria-hidden className="grid size-14 shrink-0 place-items-center rounded-2xl bg-white/10 text-3xl">{t.icon}</span>
            <div>
              <h1 id="t-h" className="text-2xl font-semibold tracking-tight">{t.label}</h1>
              <p className="mt-1 text-sm text-muted">{t.blurb}</p>
            </div>
          </div>
        </div>

        <figure className="glass p-5">
          <figcaption className="mb-2 text-xs uppercase tracking-wide text-faint">How {t.agentName} answers</figcaption>
          <blockquote className="text-lg leading-snug">“{t.greeting.replace("{business}", "your business").replace("{agent_name}", t.agentName)}”</blockquote>
        </figure>

        <div className="grid gap-4 sm:grid-cols-2">
          <Block title="Calls it takes" items={t.handles} />
          <Block title="What it asks every caller" items={t.asks} />
          <Block title="Hands to a person when" items={handoffs} note="Live transfer needs a phone line. Until then the agent promises a quick callback and records the call as urgent." />
          <Block title="Rules it always follows" items={nevers} note="Plus a few safety rules every agent has. You can edit all of them." />
        </div>
      </section>

      <aside className="glass h-fit p-5 lg:sticky lg:top-20" aria-labelledby="form-h">
        <h2 id="form-h" className="mb-4 font-medium">Make it yours</h2>
        <TemplateForm
          accountId={accounts[0].id}
          templateKey={t.key}
          defaultName={`${t.label} receptionist`}
          defaultDescription={t.description}
        />
      </aside>
    </div>
  );
}

function Block({ title, items, note }: { title: string; items: string[]; note?: string }) {
  return (
    <section className="glass p-4">
      <h2 className="mb-2 text-sm font-medium">{title}</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted marker:text-faint">
        {items.map((x) => <li key={x}>{x}</li>)}
      </ul>
      {note && <p className="mt-3 text-xs text-faint">{note}</p>}
    </section>
  );
}
