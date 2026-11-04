"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { previewConfig, publishVersion, saveVersion, type PreviewResult } from "@/app/actions";
import type { AgentConfig, ValidationIssue } from "@/lib/config";
import {
  AreaField, NumberField, SelectField, StringList, TextField, Toggle, issuesAt,
} from "./fields";

const SECTIONS = [
  ["persona", "Persona"],
  ["greetings", "Greetings"],
  ["guardrails", "Guardrails"],
  ["escalation", "Escalation"],
  ["tools", "Tools"],
  ["policy", "Speaking & flows"],
  ["runtime", "Runtime"],
  ["json", "Advanced (JSON)"],
] as const;
type SectionKey = (typeof SECTIONS)[number][0];

interface Props {
  agent: { id: string; name: string };
  initial: AgentConfig;
  latest: { id: string; version: number };
  published: { id: string; version: number } | null;
}

export function Editor({ agent, initial, latest, published }: Props) {
  const router = useRouter();
  const [config, setConfig] = useState<AgentConfig>(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [head, setHead] = useState(latest);
  const [section, setSection] = useState<SectionKey>("persona");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, startBusy] = useTransition();

  const dirty = useMemo(() => JSON.stringify(config) !== saved, [config, saved]);
  const issues: ValidationIssue[] = preview && !preview.ok && "errors" in preview ? preview.errors : [];
  const isLive = published?.id === head.id;

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

  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  function save() {
    setMessage(null);
    startBusy(async () => {
      const res = await saveVersion(agent.id, config, note);
      if (!res.ok) {
        if (res.issues) setPreview({ ok: false, errors: res.issues });
        setMessage({ kind: "error", text: res.error });
        return;
      }
      setSaved(JSON.stringify(config));
      setHead({ id: res.id, version: res.version });
      setNote("");
      setMessage({ kind: "ok", text: `Saved as version ${res.version}. It is not live until you publish it.` });
      router.refresh();
    });
  }

  function publish() {
    setMessage(null);
    startBusy(async () => {
      const res = await publishVersion(agent.id, head.id);
      if (res.error) return setMessage({ kind: "error", text: res.error });
      setMessage({ kind: "ok", text: `Version ${head.version} is live. New calls use it.` });
      router.refresh();
    });
  }

  return (
    <div className="w-full min-w-0 space-y-4">
      <div className="glass flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{agent.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span className="chip">{dirty ? "Unsaved changes" : `v${head.version} saved`}</span>
            {published ? (
              <span className="chip chip-live">Live · v{published.version}</span>
            ) : (
              <span className="chip">Not published</span>
            )}
            <Link href={`/agents/${agent.id}/versions`} className="link">History & rollback</Link>
            <Link href={`/agents/${agent.id}/talk`} className="link">Talk to it</Link>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="What changed (optional)" placeholder="What changed? (optional)"
            className="field w-56" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
            disabled={!dirty}
          />
          <button className="btn btn-primary" onClick={save} disabled={!dirty || busy || issues.length > 0}>
            {busy ? "Working…" : "Save version"}
          </button>
          <button className="btn" onClick={publish} disabled={dirty || busy || isLive}
            title={dirty ? "Save your changes first" : isLive ? "This version is already live" : undefined}>
            Publish v{head.version}
          </button>
        </div>
        <p role="status" aria-live="polite"
          className={`w-full text-sm ${message?.kind === "error" ? "text-danger" : "text-ok"} ${message ? "" : "hidden"}`}>
          {message?.text}
        </p>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[13rem_minmax(0,1fr)_minmax(0,26rem)]">
        <nav aria-label="Sections" className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col">
            {SECTIONS.map(([key, label]) => {
              const count = issues.filter((i) => topLevel(i.path) === key).length;
              return (
                <li key={key}>
                  <button
                    onClick={() => setSection(key)}
                    aria-current={section === key ? "page" : undefined}
                    className={`flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent ${
                      section === key ? "bg-white/10 text-text" : "text-muted"
                    }`}
                  >
                    {label}
                    {count ? <span className="rounded-full bg-danger/20 px-1.5 text-xs text-danger" aria-label={`${count} problems`}>{count}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <section className="glass min-w-0 space-y-5 p-5" aria-label={SECTIONS.find((s) => s[0] === section)?.[1]}>
          {section === "persona" && <PersonaSection config={config} set={set} issues={issues} />}
          {section === "greetings" && <GreetingsSection config={config} set={set} issues={issues} />}
          {section === "guardrails" && (
            <StringList
              label="Guardrails" items={config.guardrails} path="guardrails" issues={issues}
              addLabel="Add guardrail" max={30}
              onChange={(v) => set("guardrails", v)}
              hint="Hard rules the agent never breaks, for example what it must not promise."
            />
          )}
          {section === "escalation" && <EscalationSection config={config} set={set} issues={issues} />}
          {section === "tools" && <ToolsSection config={config} set={set} issues={issues} />}
          {section === "policy" && <PolicySection config={config} set={set} issues={issues} />}
          {section === "runtime" && <RuntimeSection config={config} set={set} issues={issues} />}
          {section === "json" && <JsonSection config={config} onValid={setConfig} />}
        </section>

        <PreviewPane preview={preview} />
      </div>
    </div>
  );
}

const topLevel = (path: string) => {
  const head = path.split(".")[0];
  return head === "policy" ? "policy" : head;
};

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
        onChange={(v) => up({ business_description: v })} hint="Hours, services and service area. The agent can only speak to what is written here or returned by a tool." />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Tone" value={p.tone} onChange={(v) => up({ tone: v })}
          options={[{ value: "warm", label: "Warm" }, { value: "professional", label: "Professional" }, { value: "upbeat", label: "Upbeat" }, { value: "calm", label: "Calm" }]} />
        <TextField label="Time zone" value={p.timezone} path="persona.timezone" issues={issues} onChange={(v) => up({ timezone: v })} hint="IANA name, e.g. America/Chicago. Sets what “today” means." />
      </div>
      <TextField label="Languages" value={p.languages.join(", ")} path="persona.languages" issues={issues}
        onChange={(v) => up({ languages: v.split(",").map((s) => s.trim()).filter(Boolean) })} hint="Comma-separated codes, e.g. en, es." />
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

function EscalationSection({ config, set, issues }: SectionProps) {
  const rules = config.escalation;
  const upAt = (i: number, patch: Partial<(typeof rules)[number]>) =>
    set("escalation", rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      {rules.length === 0 && <p className="text-sm text-muted">No escalation rules. The agent will not transfer or take messages unless a tool does.</p>}
      <ul className="space-y-4">
        {rules.map((r, i) => (
          <li key={i} className="space-y-3 rounded-xl border border-line p-4">
            <TextField label={`Rule ${i + 1}: when`} value={r.condition} path={`escalation.${i}.condition`} issues={issues}
              onChange={(v) => upAt(i, { condition: v })} hint="Finish the sentence “If …”, for example “the caller reports a gas smell”." />
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="Then" value={r.action} onChange={(v) => upAt(i, { action: v })}
                options={[{ value: "transfer", label: "Transfer to a person" }, { value: "take_message", label: "Take a message" }, { value: "end_call", label: "End the call" }]} />
              <TextField label="Note for the person" value={r.handoff_summary} path={`escalation.${i}.handoff_summary`} issues={issues} onChange={(v) => upAt(i, { handoff_summary: v })} />
            </div>
            <button type="button" className="btn btn-quiet btn-danger" onClick={() => set("escalation", rules.filter((_, j) => j !== i))}>Remove rule {i + 1}</button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" disabled={rules.length >= 20}
        onClick={() => set("escalation", [...rules, { condition: "", action: "transfer", handoff_summary: "Caller {reason}. Summarize what they need in one sentence." }])}>
        Add rule
      </button>
    </>
  );
}

function ToolsSection({ config, set, issues }: SectionProps) {
  const adapterNames = Object.keys(config.adapters);
  const upTool = (i: number, patch: Partial<(typeof config.tools)[number]>) =>
    set("tools", config.tools.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <>
      <p className="text-sm text-muted">
        Tools are what the agent can do during a call. New tools and connection details for live systems are
        added in <strong className="font-medium text-text">Advanced (JSON)</strong>.
      </p>
      <ul className="space-y-4">
        {config.tools.map((t, i) => {
          const kind = config.adapters[t.adapter]?.kind;
          return (
            <li key={t.name} className="space-y-3 rounded-xl border border-line p-4">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-sm">{t.name}</code>
                {kind === "disabled" && <span className="chip">Off</span>}
                {t.goal && <span className="chip">Counts as goal reached</span>}
              </div>
              <AreaField label="What it does (the agent reads this)" value={t.description} path={`tools.${i}.description`} issues={issues} rows={2}
                onChange={(v) => upTool(i, { description: v })} />
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField label="Connected to" value={t.adapter} onChange={(v) => upTool(i, { adapter: v })}
                  options={adapterNames.map((n) => ({ value: n, label: `${n} (${config.adapters[n].kind})` }))} />
                <div className="self-end pb-2">
                  <Toggle label="Successful use means the call reached its goal" checked={t.goal} onChange={(v) => upTool(i, { goal: v })} />
                </div>
              </div>
              {Object.keys(t.parameters).length > 0 && (
                <p className="text-xs text-faint">
                  Asks for: {Object.entries(t.parameters).map(([n, s]) => `${n}${s.required === false ? " (optional)" : ""}`).join(", ")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <fieldset className="space-y-3">
        <legend className="label">Connections</legend>
        {adapterNames.map((n) => (
          <SelectField key={n} label={n} value={config.adapters[n].kind}
            onChange={(v) => set("adapters", { ...config.adapters, [n]: { ...config.adapters[n], kind: v } })}
            options={[{ value: "mock", label: "Demo data" }, { value: "http", label: "Live system (configure in JSON)" }, { value: "disabled", label: "Off" }]}
            hint={n === "demo_data" ? "Demo data answers with made-up examples. Switch to a live system before real calls." : undefined} />
        ))}
      </fieldset>
    </>
  );
}

function PolicySection({ config, set, issues }: SectionProps) {
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
        onChange={(v) => up({ backend_flows: v })} hint="How the agent should carry out bookings, quotes and callbacks. Used by the model that runs tools." />
    </>
  );
}

function RuntimeSection({ config, set, issues }: SectionProps) {
  const r = config.runtime;
  const up = (patch: Partial<typeof r>) => set("runtime", { ...r, ...patch });
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Voice" value={r.voice.voice} path="runtime.voice.voice" issues={issues}
          onChange={(v) => up({ voice: { ...r.voice, voice: v } })} hint="The speaking voice, e.g. marin." />
        <TextField label="Voice model" value={r.voice.model} path="runtime.voice.model" issues={issues}
          onChange={(v) => up({ voice: { ...r.voice, model: v } })} />
        <NumberField label="Longest call (seconds)" value={r.max_call_seconds} min={60} max={3600} path="runtime.max_call_seconds" issues={issues}
          onChange={(v) => up({ max_call_seconds: v })} hint="60 to 3600." />
        <NumberField label="Silence before “still there?” (seconds)" value={r.silence_timeout_seconds} min={5} max={120} path="runtime.silence_timeout_seconds" issues={issues}
          onChange={(v) => up({ silence_timeout_seconds: v })} hint="5 to 120." />
      </div>
      <p className="text-sm text-muted">Backup voice models and Azure settings are in Advanced (JSON).</p>
    </>
  );
}

function JsonSection({ config, onValid }: { config: AgentConfig; onValid: (c: AgentConfig) => void }) {
  const [text, setText] = useState(() => JSON.stringify(config, null, 2));
  const [error, setError] = useState<string | null>(null);
  const lastPushed = useRef(JSON.stringify(config));

  // Pick up edits made in the other sections while this tab was closed.
  useEffect(() => {
    const now = JSON.stringify(config);
    if (now !== lastPushed.current) {
      lastPushed.current = now;
      setText(JSON.stringify(config, null, 2));
      setError(null);
    }
  }, [config]);

  return (
    <div>
      <AreaField label="Full configuration" value={text} path="" rows={30} mono
        hint="Everything the agent is. Changes apply to the preview as soon as the JSON is valid; Save version stores them."
        onChange={(v) => {
          setText(v);
          try {
            const parsed = JSON.parse(v);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Must be a JSON object.");
            setError(null);
            lastPushed.current = JSON.stringify(parsed);
            onValid(parsed);
          } catch (e) {
            setError((e as Error).message);
          }
        }} />
      {error && <p role="alert" className="mt-2 text-sm text-danger">Not valid JSON yet: {error}</p>}
    </div>
  );
}

type Tab = "voice" | "backend" | "lines" | "tools";

function PreviewPane({ preview }: { preview: PreviewResult | null }) {
  const [tab, setTab] = useState<Tab>("voice");
  const tabs: [Tab, string][] = [["voice", "Voice prompt"], ["backend", "Tool prompt"], ["lines", "Spoken lines"], ["tools", "Tools"]];
  const ok = preview?.ok ? preview.compiled : null;

  return (
    <aside className="glass flex min-h-80 min-w-0 flex-col lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start" aria-label="What the model receives">
      <div className="border-b border-line p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">What the model receives</h2>
          {ok && <code className="font-mono text-xs text-faint" title="Changes only when the model's instructions change">{ok.fingerprint.slice(0, 8)}</code>}
        </div>
        <div role="tablist" aria-label="Preview" className="flex gap-1 overflow-x-auto">
          {tabs.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-accent ${tab === k ? "bg-white/12 text-text" : "text-muted hover:bg-white/5"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4" role="tabpanel">
        {preview === null && <p className="text-sm text-muted">Compiling…</p>}
        {preview && !preview.ok && "unavailable" in preview && (
          <p className="text-sm text-warn">The preview service is not reachable, so this can&apos;t be checked or saved right now.</p>
        )}
        {preview && !preview.ok && "errors" in preview && (
          <div role="alert">
            <p className="mb-2 text-sm font-medium text-danger">{preview.errors.length} problem{preview.errors.length === 1 ? "" : "s"} to fix</p>
            <ul className="space-y-1 text-sm text-muted">
              {preview.errors.map((e, i) => (
                <li key={i}><code className="font-mono text-xs text-faint">{e.path || "config"}</code> {e.message}</li>
              ))}
            </ul>
          </div>
        )}
        {ok && tab === "voice" && <pre className="prose-prompt">{ok.voice_instructions}</pre>}
        {ok && tab === "backend" && <pre className="prose-prompt">{ok.backend_instructions}</pre>}
        {ok && tab === "lines" && (
          <dl className="space-y-4 text-sm">
            {[["Opening", ok.opening_line], ["Quiet caller", ok.still_there_line], ["Goodbye", ok.goodbye_line]].map(([k, v]) => (
              <div key={k}><dt className="label">{k}</dt><dd>“{v}”</dd></div>
            ))}
          </dl>
        )}
        {ok && tab === "tools" && (
          <ul className="space-y-3 text-sm">
            {ok.tools.length === 0 && <li className="text-muted">No tools are on.</li>}
            {ok.tools.map((t) => (
              <li key={t.name}><code className="font-mono">{t.name}</code><p className="text-muted">{t.description}</p></li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

export { issuesAt };
