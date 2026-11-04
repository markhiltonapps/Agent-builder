"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import {
  askAiToChange, duplicateAgent, previewConfig, publishVersion, saveVersion, type PreviewResult,
} from "@/app/actions";
import type { AgentConfig, ValidationIssue } from "@/lib/config";
import { diffJson, type Json } from "@/lib/diff";
import { labelFor } from "@/lib/labels";
import { ChangeList } from "./change-list";
import { AreaField, CsvField, NumberField, SelectField, StringList, TextField, Toggle } from "./fields";

const SECTIONS = [
  ["persona", "Persona", "Who answers the phone."],
  ["greetings", "Greetings", "The first thing callers hear, plus a few other spoken lines."],
  ["rules", "Rules", "Things the agent must never say or promise, for example “Never quote a price over the phone.”"],
  ["handoffs", "Handoffs", "When the agent should pass a caller to a person or take a message."],
  ["actions", "Actions", "What the agent can do during a call, like checking prices or booking a visit."],
  ["flows", "Speaking & steps", "How the agent speaks, and written steps for the most common calls."],
  ["voice", "Voice & limits", "The voice and how long a call can run. Leave these alone unless Neato tells you otherwise."],
  ["advanced", "Advanced settings", "For technical users. A mistake here can break your agent."],
] as const;
type SectionKey = (typeof SECTIONS)[number][0];

interface Props {
  agent: { id: string; name: string };
  initial: AgentConfig;
  latest: { id: string; version: number };
  published: { id: string; version: number } | null;
}

const sectionOf = (path: string): SectionKey => {
  const head = path.split(".")[0];
  if (head === "persona") return "persona";
  if (head === "greetings") return "greetings";
  if (head === "guardrails") return "rules";
  if (head === "escalation") return "handoffs";
  if (head === "tools" || head === "adapters") return "actions";
  if (head === "policy") return "flows";
  if (head === "runtime") return "voice";
  return "advanced";
};

const friendly = (name: string) => name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const KIND_LABEL = { mock: "Sample data", http: "Real system", disabled: "Off" } as const;

export function Editor({ agent, initial, latest, published }: Props) {
  const router = useRouter();
  const [config, setConfig] = useState<AgentConfig>(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [head, setHead] = useState(latest);
  const [section, setSection] = useState<SectionKey>("persona");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState<"save" | "publish" | null>(null);
  const [, startTransition] = useTransition();
  const navRef = useRef<HTMLUListElement>(null);

  const dirty = useMemo(() => JSON.stringify(config) !== saved, [config, saved]);
  const issues: ValidationIssue[] = preview && !preview.ok && "errors" in preview ? preview.errors : [];
  const isLive = published?.id === head.id;
  const usesSampleData = Object.values(config.adapters).some((a) => a.kind === "mock");
  const busy = pending !== null;

  // Live preview: validate and compile with the same Python code the worker runs.
  const ticket = useRef(0);
  useEffect(() => {
    const mine = ++ticket.current;
    const t = setTimeout(async () => {
      const result = await previewConfig(config);
      if (mine === ticket.current) setPreview(result);
    }, 350);
    return () => clearTimeout(t);
  }, [config]);

  // Closing the tab or reloading with unsaved work asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // On narrow screens the section row scrolls; keep the active one in view.
  useEffect(() => {
    if (window.matchMedia("(max-width: 1023px)").matches) {
      navRef.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }, [section]);

  const leaveGuard = (e: React.MouseEvent) => {
    if (dirty && !window.confirm("You have unsaved changes. Leave without saving?")) e.preventDefault();
  };

  // Every edit goes through here: a "Saved" message is about the past, so an edit clears it.
  const edit = (next: AgentConfig | ((c: AgentConfig) => AgentConfig)) => {
    setMessage(null);
    setConfig(next);
  };
  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) =>
    edit((c) => ({ ...c, [key]: value }));

  function save() {
    setMessage(null);
    setPending("save");
    startTransition(async () => {
      const res = await saveVersion(agent.id, config, note);
      setPending(null);
      if (!res.ok) {
        if (res.issues) setPreview({ ok: false, errors: res.issues });
        setMessage({ kind: "error", text: res.error });
        return;
      }
      setSaved(JSON.stringify(config));
      setHead({ id: res.id, version: res.version });
      setNote("");
      setMessage({ kind: "ok", text: `Saved as version ${res.version}. It isn't live until you publish it.` });
      router.refresh();
    });
  }

  function publish() {
    const ok = window.confirm(
      `Make version ${head.version} live?\n\nNew calls will use it. Calls already in progress aren't affected.` +
        (usesSampleData
          ? "\n\nThis agent still uses sample data for its actions, so things like prices and times are made up."
          : ""),
    );
    if (!ok) return;
    setMessage(null);
    setPending("publish");
    startTransition(async () => {
      const res = await publishVersion(agent.id, head.id);
      setPending(null);
      if (res.error) return setMessage({ kind: "error", text: res.error });
      setMessage({ kind: "ok", text: `Version ${head.version} is live. New calls use it.` });
      router.refresh();
    });
  }

  const saveReason = !dirty ? "" : issues.length ? `Fix ${issues.length} problem${issues.length === 1 ? "" : "s"} in the preview to save.` : "";
  const publishReason = dirty ? "Save your changes before publishing." : isLive ? "This version is already live." : "";

  return (
    <div className="w-full min-w-0 space-y-4">
      <div className="glass sticky top-14 z-10 space-y-2 bg-[#0e0f16]/95 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{agent.name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
              <span className="chip">{dirty ? "Unsaved changes" : `Version ${head.version} saved`}</span>
              {published ? <span className="chip chip-live">Live: version {published.version}</span> : <span className="chip">Not live yet</span>}
            </p>
            <div className="-ml-3 mt-1 flex flex-wrap items-center">
              <Link href={`/agents/${agent.id}/versions`} onClick={leaveGuard} className="btn btn-quiet">Version history</Link>
              <Link href={`/agents/${agent.id}/talk`} onClick={leaveGuard} className="btn btn-quiet">Test call</Link>
              <Link href={`/calls?agent=${agent.id}`} onClick={leaveGuard} className="btn btn-quiet">Past calls</Link>
              <form
                action={duplicateAgent}
                onSubmit={(e) => {
                  if (dirty && !window.confirm("Copy the last saved version? Your unsaved changes won't be included.")) e.preventDefault();
                }}
              >
                <input type="hidden" name="agent_id" value={agent.id} />
                <button className="btn btn-quiet">Duplicate</button>
              </form>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {dirty && (
              <input
                aria-label="What changed (optional)" placeholder="What changed? (optional)"
                className="field w-56" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
              />
            )}
            <button className={`btn ${dirty ? "btn-primary" : ""}`} onClick={save} disabled={!dirty || busy || issues.length > 0}>
              {pending === "save" ? "Saving…" : "Save changes"}
            </button>
            <button className={`btn ${!dirty && !isLive ? "btn-primary" : ""}`} onClick={publish} disabled={dirty || busy || isLive}>
              {pending === "publish" ? "Publishing…" : `Publish version ${head.version}`}
            </button>
          </div>
        </div>
        <p className="text-xs text-faint">
          Saving keeps a draft. Callers reach your agent only after you publish.
          {(saveReason || publishReason) && <span className="ml-1 text-muted">{saveReason || publishReason}</span>}
        </p>
        <p role="status" aria-live="polite" className={`text-sm empty:hidden ${message?.kind === "error" ? "text-danger" : "text-ok"}`}>
          {message?.text ?? ""}
        </p>
      </div>

      {!published && head.version === 1 && !dirty && (
        <aside className="glass p-4 text-sm" aria-label="Getting started">
          <p className="mb-2 font-medium">Getting started</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>Make it yours. Change anything on the left, and the preview shows what your agent will be told.</li>
            <li>Choose <strong className="font-medium text-text">Publish version 1</strong> to put it live.</li>
            <li>Choose <strong className="font-medium text-text">Test call</strong> and talk to it.</li>
          </ol>
        </aside>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,1fr)_minmax(0,26rem)]">
        <nav aria-label="Sections" className="min-w-0 lg:sticky lg:top-56 lg:self-start">
          <ul ref={navRef} className="scroll-fade flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            {SECTIONS.map(([key, label]) => {
              const count = issues.filter((i) => sectionOf(i.path) === key).length;
              const active = section === key;
              return (
                <li key={key} className="shrink-0">
                  <button
                    onClick={() => setSection(key)}
                    aria-pressed={active}
                    className={`flex min-h-11 w-full items-center justify-between gap-2 whitespace-nowrap rounded-lg border-l-2 px-3 py-2 text-left text-sm transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent lg:min-h-0 ${
                      active ? "border-accent bg-white/10 font-medium text-text" : "border-transparent text-muted"
                    }`}
                  >
                    {label}
                    {count ? <span className="rounded-full bg-danger/20 px-1.5 text-xs text-danger"><span className="sr-only">{count} problems in {label}: </span><span aria-hidden>{count}</span></span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 space-y-4">
          <AskAi config={config} onApply={edit} />
          <section className="glass min-w-0 space-y-5 p-5" aria-labelledby="section-h">
            <div>
              <h2 id="section-h" className="text-lg font-semibold">{SECTIONS.find((s) => s[0] === section)?.[1]}</h2>
              <p className="mt-1 text-sm text-muted">{SECTIONS.find((s) => s[0] === section)?.[2]}</p>
            </div>
            {section === "persona" && <PersonaSection config={config} set={set} issues={issues} />}
            {section === "greetings" && <GreetingsSection config={config} set={set} issues={issues} />}
            {section === "rules" && (
              <StringList
                label="Rules" itemName="Rule" items={config.guardrails} path="guardrails" issues={issues}
                addLabel="Add a rule" max={30} onChange={(v) => set("guardrails", v)}
              />
            )}
            {section === "handoffs" && <HandoffSection config={config} set={set} issues={issues} />}
            {section === "actions" && <ActionsSection config={config} set={set} issues={issues} />}
            {section === "flows" && <FlowsSection config={config} set={set} issues={issues} />}
            {section === "voice" && <VoiceSection config={config} set={set} issues={issues} />}
            {section === "advanced" && <JsonSection config={config} onValid={edit} />}
          </section>
        </div>

        <div className="min-w-0 lg:col-start-2 xl:col-start-3 xl:row-start-1">
          <button
            className="btn mb-3 w-full lg:hidden" aria-expanded={previewOpen} aria-controls="preview-pane"
            onClick={() => setPreviewOpen((o) => !o)}
          >
            {previewOpen ? "Hide preview" : `Show preview of what your agent is told${issues.length ? ` (${issues.length} problem${issues.length === 1 ? "" : "s"})` : ""}`}
          </button>
          <div id="preview-pane" className={previewOpen ? "block" : "hidden lg:block"}>
            <PreviewPane preview={preview} />
          </div>
        </div>
      </div>
    </div>
  );
}

type SectionProps = {
  config: AgentConfig;
  set: <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => void;
  issues: ValidationIssue[];
};

function PersonaSection({ config, set, issues }: SectionProps) {
  const p = config.persona;
  const up = (patch: Partial<typeof p>) => set("persona", { ...p, ...patch });
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Agent name" value={p.agent_name} path="persona.agent_name" issues={issues} onChange={(v) => up({ agent_name: v })} maxLength={200} />
        <TextField label="Business name" value={p.business_name} path="persona.business_name" issues={issues} onChange={(v) => up({ business_name: v })} maxLength={200} />
      </div>
      <AreaField label="About the business" value={p.business_description} path="persona.business_description" issues={issues} rows={3} maxLength={1000}
        onChange={(v) => up({ business_description: v })} hint="Hours, services and service area. The agent can only speak to what is written here or returned by an action." />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Tone" value={p.tone} onChange={(v) => up({ tone: v })}
          options={[{ value: "warm", label: "Warm" }, { value: "professional", label: "Professional" }, { value: "upbeat", label: "Upbeat" }, { value: "calm", label: "Calm" }]} />
        <TextField label="Time zone" value={p.timezone} path="persona.timezone" issues={issues} onChange={(v) => up({ timezone: v })}
          hint="Your business's time zone, like America/Chicago. Used for “today” and opening hours." />
      </div>
      <CsvField label="Languages" values={p.languages} path="persona.languages" issues={issues}
        onCommit={(v) => up({ languages: v })} hint="Use en for English, es for Spanish. Separate with commas." />
      <AreaField label="If asked “are you a person?”" value={p.bot_disclosure} path="persona.bot_disclosure" issues={issues} rows={2} maxLength={300}
        onChange={(v) => up({ bot_disclosure: v })} hint="Use {business} and {agent_name} to fill in names." />
    </>
  );
}

function GreetingsSection({ config, set, issues }: SectionProps) {
  const g = config.greetings;
  const up = (patch: Partial<typeof g>) => set("greetings", { ...g, ...patch });
  const hint = "Use {business} and {agent_name} to fill in names.";
  return (
    <>
      <TextField label="Opening line" value={g.opening} path="greetings.opening" issues={issues} onChange={(v) => up({ opening: v })} hint={hint} />
      <TextField label="When the caller goes quiet" value={g.still_there} path="greetings.still_there" issues={issues} onChange={(v) => up({ still_there: v })} />
      <TextField label="Goodbye" value={g.goodbye} path="greetings.goodbye" issues={issues} onChange={(v) => up({ goodbye: v })} hint={hint} />
    </>
  );
}

function HandoffSection({ config, set, issues }: SectionProps) {
  const rules = config.escalation;
  const upAt = (i: number, patch: Partial<(typeof rules)[number]>) =>
    set("escalation", rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      {rules.length === 0 && <p className="text-sm text-muted">No handoff rules yet. The agent handles every call itself.</p>}
      <ul className="space-y-4">
        {rules.map((r, i) => (
          <li key={i} className="space-y-3 rounded-xl border border-line p-4">
            <TextField label={`Handoff ${i + 1}: when`} value={r.condition} path={`escalation.${i}.condition`} issues={issues}
              onChange={(v) => upAt(i, { condition: v })} hint="Finish the sentence “If …”, for example “the caller reports a gas smell”." />
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="Then the agent should" value={r.action} onChange={(v) => upAt(i, { action: v })}
                options={[{ value: "transfer", label: "Transfer to a person" }, { value: "take_message", label: "Take a message" }, { value: "end_call", label: "End the call" }]} />
              <TextField label="Note for whoever takes over" value={r.handoff_summary} path={`escalation.${i}.handoff_summary`} issues={issues}
                onChange={(v) => upAt(i, { handoff_summary: v })} hint="{reason} fills in why they called." />
            </div>
            <button type="button" className="btn btn-quiet btn-danger" onClick={() => set("escalation", rules.filter((_, j) => j !== i))}>Remove handoff {i + 1}</button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" disabled={rules.length >= 20}
        onClick={() => set("escalation", [...rules, { condition: "", action: "transfer", handoff_summary: "Caller {reason}. Summarize what they need in one sentence." }])}>
        Add a handoff
      </button>
    </>
  );
}

function ActionsSection({ config, set, issues }: SectionProps) {
  const adapterNames = Object.keys(config.adapters);
  const upTool = (i: number, patch: Partial<(typeof config.tools)[number]>) =>
    set("tools", config.tools.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <>
      <p className="text-sm text-muted">To add actions or connect a real system, ask Neato.</p>
      {config.tools.length === 0 && (
        <p className="text-sm text-muted">This agent has no custom actions yet. It can still take messages and transfer calls.</p>
      )}
      <ul className="space-y-4">
        {config.tools.map((t, i) => {
          const kind = config.adapters[t.adapter]?.kind;
          return (
            <li key={t.name} className="space-y-3 rounded-xl border border-line bg-black/20 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-sm">{t.name}</code>
                {kind === "disabled" && <span className="chip">Off</span>}
                {kind === "mock" && <span className="chip">Sample data</span>}
                {t.goal && <span className="chip">Marks the call successful</span>}
              </div>
              <AreaField label="What it does (the agent reads this)" value={t.description} path={`tools.${i}.description`} issues={issues} rows={2}
                onChange={(v) => upTool(i, { description: v })} />
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField label="Gets its answers from" value={t.adapter} onChange={(v) => upTool(i, { adapter: v })}
                  options={adapterNames.map((n) => ({ value: n, label: `${friendly(n)} (${KIND_LABEL[config.adapters[n].kind]})` }))} />
                <div className="self-end">
                  <Toggle label="Count the call as successful when this works (for example, a booking is made)" checked={t.goal} onChange={(v) => upTool(i, { goal: v })} />
                </div>
              </div>
              {Object.keys(t.parameters).length > 0 && (
                <p className="text-xs text-faint">
                  Asks the caller for: {Object.entries(t.parameters).map(([n, s]) => `${friendly(n).toLowerCase()}${s.required === false ? " (optional)" : ""}`).join(", ")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {adapterNames.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="label">Connections</legend>
          {adapterNames.map((n) => (
            <SelectField key={n} label={friendly(n)} value={config.adapters[n].kind}
              onChange={(v) => set("adapters", { ...config.adapters, [n]: { ...config.adapters[n], kind: v } })}
              options={[{ value: "mock", label: "Sample data (practice only)" }, { value: "http", label: "Real system (needs setup by Neato)" }, { value: "disabled", label: "Off" }]}
              hint={config.adapters[n].kind === "mock" ? "Sample data gives made-up answers. Switch to a real system before real callers use this agent." : undefined} />
          ))}
        </fieldset>
      )}
    </>
  );
}

function FlowsSection({ config, set, issues }: SectionProps) {
  const p = config.policy;
  const up = (patch: Partial<typeof p>) => set("policy", { ...p, ...patch });
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="When the caller interrupts" value={p.interruption} onChange={(v) => up({ interruption: v })}
          options={[{ value: "yield_immediately", label: "Stop talking right away" }, { value: "finish_sentence", label: "Finish the sentence" }]} />
        <SelectField label="Listening sounds (“mm-hm”)" value={p.backchannel} onChange={(v) => up({ backchannel: v })}
          options={[{ value: "none", label: "None" }, { value: "light", label: "Occasional" }, { value: "natural", label: "Natural" }]} />
      </div>
      <AreaField label="Extra speaking rules" value={p.speaking_rules} path="policy.speaking_rules" issues={issues} rows={4} maxLength={8000} mono
        onChange={(v) => up({ speaking_rules: v })} hint="Added to the built-in phone rules." />
      <AreaField label="Step-by-step flows" value={p.backend_flows} path="policy.backend_flows" issues={issues} rows={14} maxLength={8000} mono
        onChange={(v) => up({ backend_flows: v })} hint="Written steps for bookings, quotes and callbacks, for example “Ask for the ZIP code first.”" />
    </>
  );
}

function VoiceSection({ config, set, issues }: SectionProps) {
  const r = config.runtime;
  const up = (patch: Partial<typeof r>) => set("runtime", { ...r, ...patch });
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Voice" value={r.voice.voice} path="runtime.voice.voice" issues={issues}
          onChange={(v) => up({ voice: { ...r.voice, voice: v } })} hint="The speaking voice, like marin." />
        <TextField label="Voice model" value={r.voice.model} path="runtime.voice.model" issues={issues}
          onChange={(v) => up({ voice: { ...r.voice, model: v } })} hint="Leave as is unless Neato tells you otherwise." />
        <NumberField label="Longest call (seconds)" value={r.max_call_seconds} min={60} max={3600} path="runtime.max_call_seconds" issues={issues}
          onChange={(v) => up({ max_call_seconds: v })} hint="Ends the call after this long. 60 to 3600 seconds." />
        <NumberField label="Quiet time before the agent checks in (seconds)" value={r.silence_timeout_seconds} min={5} max={120} path="runtime.silence_timeout_seconds" issues={issues}
          onChange={(v) => up({ silence_timeout_seconds: v })} hint="5 to 120 seconds." />
      </div>
    </>
  );
}

function JsonSection({ config, onValid }: { config: AgentConfig; onValid: (c: AgentConfig) => void }) {
  const [text, setText] = useState(() => JSON.stringify(config, null, 2));
  const [error, setError] = useState(false);
  const lastPushed = useRef(JSON.stringify(config));

  // Pick up edits made in the other sections while this tab was closed.
  useEffect(() => {
    const now = JSON.stringify(config);
    if (now !== lastPushed.current) {
      lastPushed.current = now;
      setText(JSON.stringify(config, null, 2));
      setError(false);
    }
  }, [config]);

  return (
    <div>
      <AreaField label="All settings (JSON)" value={text} path="" rows={30} mono
        hint="Everything the agent is. Changes appear in the preview as soon as they can be read. Save changes keeps them."
        onChange={(v) => {
          setText(v);
          try {
            const parsed = JSON.parse(v);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
            setError(false);
            lastPushed.current = JSON.stringify(parsed);
            onValid(parsed);
          } catch {
            setError(true);
          }
        }} />
      <p role="alert" className="mt-2 text-sm text-danger empty:hidden">
        {error ? "These settings can't be read yet, so nothing is applied. Check for a missing comma or quote." : ""}
      </p>
    </div>
  );
}

function AskAi({ config, onApply }: { config: AgentConfig; onApply: (c: AgentConfig) => void }) {
  const id = useId();
  const [request, setRequest] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ config: AgentConfig; summary: string } | null>(null);
  const changes = proposal ? diffJson(config as unknown as Json, proposal.config as unknown as Json) : [];

  async function ask() {
    setError(null);
    setProposal(null);
    setThinking(true);
    const res = await askAiToChange(config, request);
    setThinking(false);
    if (!res.ok) return setError(res.error);
    setProposal({ config: res.config as AgentConfig, summary: res.summary });
  }

  return (
    <details className="glass p-4">
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-accent">
        Ask AI to change this agent
      </summary>
      <div className="mt-4 space-y-3">
        <div>
          <label className="label" htmlFor={id}>What should change?</label>
          <textarea
            id={id} rows={3} maxLength={2000} className="field" value={request} onChange={(e) => setRequest(e.target.value)}
            placeholder="For example: make the greeting shorter, and add a rule that we never quote prices over the phone."
          />
          <p className="hint">AI suggests changes. Nothing is applied until you choose Apply, and nothing is saved until you save.</p>
        </div>
        <button className="btn btn-primary" onClick={ask} disabled={thinking || request.trim().length < 5}>
          {thinking ? "Thinking… this can take up to a minute" : "Suggest changes"}
        </button>
        <p role="alert" className="text-sm text-danger empty:hidden">{error ?? ""}</p>
        {proposal && (
          <div className="space-y-3" role="region" aria-label="Suggested changes">
            <p className="text-sm">{proposal.summary || "Here is what AI suggests."}</p>
            {changes.length === 0 ? (
              <p className="text-sm text-muted">AI didn&apos;t change anything. Try describing the change differently.</p>
            ) : (
              <ChangeList changes={changes} />
            )}
            <div className="flex gap-2">
              {changes.length > 0 && (
                <button className="btn btn-primary" onClick={() => { onApply(proposal.config); setProposal(null); setRequest(""); }}>
                  Apply to editor
                </button>
              )}
              <button className="btn" onClick={() => setProposal(null)}>Discard</button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

type Tab = "voice" | "backend" | "lines" | "tools";
const TABS: [Tab, string][] = [["voice", "Instructions"], ["backend", "Behind the scenes"], ["lines", "Spoken lines"], ["tools", "Actions"]];

function PreviewPane({ preview }: { preview: PreviewResult | null }) {
  const base = useId();
  const [tab, setTab] = useState<Tab>("voice");
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const ok = preview?.ok ? preview.compiled : null;

  // Arrow keys, Home and End move between tabs, as the tabs pattern requires.
  const onKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex(([k]) => k === tab);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next][0]);
    refs.current[TABS[next][0]]?.focus();
  };

  return (
    <aside className="glass flex min-h-80 min-w-0 flex-col lg:max-h-[calc(100vh-14rem)] xl:sticky xl:top-56" aria-labelledby={`${base}-h`}>
      <div className="border-b border-line p-3">
        <h2 id={`${base}-h`} className="text-sm font-medium">Preview: what your agent is told</h2>
        <p className="mb-2 mt-0.5 text-xs text-faint">Exactly what it reads before every call. It updates as you edit.</p>
        <div role="tablist" aria-label="Preview sections" className="flex gap-1 overflow-x-auto" onKeyDown={onKey}>
          {TABS.map(([k, label]) => (
            <button
              key={k} id={`${base}-tab-${k}`} role="tab" aria-selected={tab === k} aria-controls={`${base}-panel`}
              tabIndex={tab === k ? 0 : -1} ref={(el) => { refs.current[k] = el; }} onClick={() => setTab(k)}
              className={`min-h-11 whitespace-nowrap rounded-md px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent lg:min-h-0 lg:py-1.5 ${tab === k ? "bg-white/15 text-text" : "text-muted hover:bg-white/5"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${tab}`} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto p-4">
        {preview === null && <p className="text-sm text-muted">Updating preview…</p>}
        {preview && !preview.ok && "unavailable" in preview && (
          <p role="alert" className="text-sm text-warn">We can&apos;t check this agent right now, so it can&apos;t be saved. Try again in a minute.</p>
        )}
        {preview && !preview.ok && "errors" in preview && (
          <div role="alert">
            <p className="mb-2 text-sm font-medium text-danger">{preview.errors.length} problem{preview.errors.length === 1 ? "" : "s"} to fix</p>
            <ul className="space-y-1 text-sm text-muted">
              {preview.errors.map((e, i) => (
                <li key={i}><strong className="font-medium text-text">{labelFor(e.path)}:</strong> {e.message}</li>
              ))}
            </ul>
          </div>
        )}
        {ok && tab === "voice" && <pre className="prose-prompt">{ok.voice_instructions}</pre>}
        {ok && tab === "backend" && <pre className="prose-prompt">{ok.backend_instructions}</pre>}
        {ok && tab === "lines" && (
          <dl className="space-y-4 text-sm">
            {[["Opening", ok.opening_line], ["When the caller goes quiet", ok.still_there_line], ["Goodbye", ok.goodbye_line]].map(([k, v]) => (
              <div key={k}><dt className="label">{k}</dt><dd>“{v}”</dd></div>
            ))}
          </dl>
        )}
        {ok && tab === "tools" && (
          <ul className="space-y-3 text-sm">
            {ok.tools.length === 0 && <li className="text-muted">No custom actions. The agent can still take messages and transfer calls.</li>}
            {ok.tools.map((t) => (
              <li key={t.name}><code className="font-mono">{t.name}</code><p className="text-muted">{t.description}</p></li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
