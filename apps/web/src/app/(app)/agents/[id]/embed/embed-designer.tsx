"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  DEFAULT_BOX, DEFAULT_STYLE, EDGES, ICONS, LOOKS, POSITIONS, SHAPES, SIZES, SWATCHES,
  type BoxStyle, type ButtonStyle, type Backdrop, type Device,
  LOGO_PATTERN, iframeSnippet, normalizeBox, normalizeStyle, parseHex, previewDocument, scriptSnippet,
} from "@/lib/embed-style";
import { uploadEmbedLogo } from "@/app/actions";

const WORDS: Record<string, string> = {
  "bottom-right": "Bottom right", "bottom-left": "Bottom left", "bottom-center": "Bottom middle",
  "top-right": "Top right", "top-left": "Top left", "top-center": "Top middle",
  pill: "Pill", rounded: "Rounded", square: "Square", circle: "Round", orb: "Glowing orb",
  small: "Small", medium: "Medium", large: "Large",
  solid: "Solid", glass: "Glass", outline: "Outline",
  none: "No icon", mic: "Microphone", phone: "Phone", chat: "Chat",
  tight: "Close", normal: "Normal", roomy: "Roomy",
  desktop: "Computer", mobile: "Phone screen", light: "Light", dark: "Dark",
};

/** A row of choices where exactly one is picked: real radio buttons, styled as pills. */
function Choice<T extends string>({ legend, value, options, onChange }: { legend: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  const name = useId();
  return (
    <fieldset>
      <legend className="label">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <label key={o} className="cursor-pointer">
            <input type="radio" name={name} value={o} checked={value === o} onChange={() => onChange(o)} className="peer sr-only" />
            <span className="chip cursor-pointer px-3 py-1.5 text-sm peer-checked:border-accent peer-checked:bg-accent/20 peer-checked:text-text peer-focus-visible:outline-2 peer-focus-visible:outline-accent">
              {WORDS[o] ?? o}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The colour as a typed hex code. Half-typed codes wait; a complete one is applied at once. */
function HexField({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const bad = draft !== null && draft.trim() !== "" && parseHex(draft) === null;
  return (
    <div>
      <label className="label" htmlFor={id}>Or type a hex code</label>
      <input id={id} className="field w-36 font-mono" value={shown} maxLength={7} spellCheck={false} autoComplete="off"
        aria-invalid={bad} aria-describedby={bad ? `${id}-hint` : undefined}
        onChange={(e) => { setDraft(e.target.value); const hex = parseHex(e.target.value); if (hex) onChange(hex); }}
        onBlur={() => setDraft(null)} />
      {bad && <p id={`${id}-hint`} className="mt-1 text-xs text-danger">A hex code looks like #0f766e (six letters or numbers, 0 to 9 and a to f).</p>}
    </div>
  );
}

/** Upload a logo (or paste the address of one), see it, and take it away again. */
function LogoField({ agentId, value, onChange }: { agentId: string; value: string; onChange: (url: string) => void }) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, startUpload] = useTransition();
  const [problem, setProblem] = useState("");
  const [typed, setTyped] = useState<string | null>(null);
  const pasted = typed ?? value;
  const badAddress = typed !== null && typed.trim() !== "" && !LOGO_PATTERN.test(typed.trim());

  function pick(file: File | undefined) {
    if (!file) return;
    setProblem("");
    if (file.size > 512 * 1024) { setProblem("That picture is too big. Use one under 512 KB."); return; }
    const form = new FormData();
    form.set("logo", file);
    startUpload(async () => {
      const r = await uploadEmbedLogo(agentId, form);
      if (r.ok) { setTyped(null); onChange(r.url); } else setProblem(r.error);
      if (fileRef.current) fileRef.current.value = "";
    });
  }

  return (
    <fieldset className="space-y-2">
      <legend className="label">Logo (optional)</legend>
      <div className="flex flex-wrap items-center gap-3">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="Your logo" className="size-12 rounded-full border border-line bg-white object-cover" />
        ) : (
          <span aria-hidden className="grid size-12 place-items-center rounded-full border border-dashed border-line text-xs text-faint">none</span>
        )}
        <input ref={fileRef} id={id} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
        <label htmlFor={id} className={`btn cursor-pointer ${busy ? "pointer-events-none opacity-60" : ""}`}>{busy ? "Uploading…" : value ? "Choose another" : "Upload a logo"}</label>
        {value && <button type="button" className="btn btn-quiet" onClick={() => { setTyped(null); onChange(""); }}>Remove</button>}
      </div>
      <p className="text-xs text-faint">PNG, JPG or WebP, under 512 KB. A square picture works best. It shows as a round badge on the button, or inside the orb.</p>
      <div role="status" aria-live="polite" className="text-sm text-danger">{problem}</div>
      <details>
        <summary className="cursor-pointer text-sm text-muted">Or use a picture that is already online</summary>
        <label className="label mt-2" htmlFor={`${id}-url`}>Picture address</label>
        <input id={`${id}-url`} className="field" placeholder="https://example.com/logo.png" value={pasted} spellCheck={false}
          aria-invalid={badAddress}
          onChange={(e) => { setTyped(e.target.value); const v = e.target.value.trim(); if (v === "" || LOGO_PATTERN.test(v)) onChange(v); }}
          onBlur={() => setTyped(null)} />
        {badAddress && <p className="mt-1 text-xs text-danger">The address has to start with https:// and have no spaces.</p>}
      </details>
    </fieldset>
  );
}

export function CopyBox({ title, hint, code }: { title: string; hint: string; code: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <h3 id={id} className="font-medium">{title}</h3>
      <p className="text-sm text-muted">{hint}</p>
      <pre aria-labelledby={id} tabIndex={0} className="overflow-x-auto whitespace-pre-wrap break-all rounded-2xl border border-line bg-black/30 p-3 text-xs leading-relaxed">{code}</pre>
      <button type="button" className="btn" onClick={async () => {
        try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* select by hand */ }
      }}>Copy code</button>
      <span role="status" aria-live="polite" className="ml-3 text-sm text-ok">{copied ? "Copied" : ""}</span>
    </div>
  );
}

// The design is remembered in this browser (so coming back finds it as you left it). It lives in
// a tiny store: localStorage when it works, memory when it is blocked.
const keyFor = (agentId: string) => `embed-look:${agentId}`;
const memory = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
function readRaw(key: string): string {
  try { return localStorage.getItem(key) ?? memory.get(key) ?? ""; } catch { return memory.get(key) ?? ""; }
}
function writeRaw(key: string, value: string) {
  memory.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* blocked: memory still holds it */ }
  listeners.forEach((l) => l());
}
function parseSaved(raw: string): { style: ButtonStyle; box: BoxStyle } {
  try {
    const p = JSON.parse(raw);
    return { style: { ...DEFAULT_STYLE, ...(p?.style ?? {}) }, box: normalizeBox(p?.box ?? {}) };
  } catch {
    return { style: DEFAULT_STYLE, box: DEFAULT_BOX };
  }
}

export function EmbedDesigner({ appUrl, agentId }: { appUrl: string; agentId: string }) {
  const raw = useSyncExternalStore(subscribe, () => readRaw(keyFor(agentId)), () => "");
  const saved = useMemo(() => parseSaved(raw), [raw]);
  const { style: typed, box } = saved;
  const style = useMemo(() => normalizeStyle(typed), [typed]); // what the preview and the code use
  const [mode, setMode] = useState<"button" | "box">("button");
  const [device, setDevice] = useState<Device>("desktop");
  const [backdrop, setBackdrop] = useState<Backdrop>("light");
  const colorId = useId();
  const labelId = useId();

  const save = (next: { style: ButtonStyle; box: BoxStyle }) => writeRaw(keyFor(agentId), JSON.stringify(next));
  const up = <K extends keyof ButtonStyle>(k: K, v: ButtonStyle[K]) => save({ style: { ...style, [k]: v }, box });
  const upBox = (k: keyof BoxStyle, v: number) => save({ style: typed, box: normalizeBox({ ...box, [k]: v }) });

  const doc = useMemo(() => previewDocument({ appUrl, agentId, mode, style, box, backdrop }), [appUrl, agentId, mode, style, box, backdrop]);
  const [shownDoc, setShownDoc] = useState(doc);
  useEffect(() => { const t = setTimeout(() => setShownDoc(doc), 120); return () => clearTimeout(t); }, [doc]);

  const changed = JSON.stringify(style) !== JSON.stringify(DEFAULT_STYLE) || JSON.stringify(box) !== JSON.stringify(DEFAULT_BOX);

  return (
    <section aria-labelledby="design-h" className="glass space-y-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="design-h" className="text-lg font-medium">Design it and get the code</h2>
        <div role="tablist" aria-label="What to place on your website" className="flex gap-1">
          {(["button", "box"] as const).map((m) => (
            <button key={m} role="tab" type="button" aria-selected={mode === m} onClick={() => setMode(m)}
              className={`nav-pill px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent ${mode === m ? "" : "text-muted hover:text-text"}`}
              {...(mode === m ? { "aria-current": "true" } : {})}>
              {m === "button" ? "Floating button" : "Built into the page"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]">
        <div className="space-y-4">
          {mode === "button" ? (
            <>
              <div>
                <label className="label" htmlFor={labelId}>{style.shape === "orb" ? "Words beside the orb" : "Words on the button"}</label>
                <input id={labelId} className="field" maxLength={40} value={typed.label} onChange={(e) => save({ style: { ...typed, label: e.target.value }, box })} />
              </div>
              <fieldset>
                <legend className="label">Color</legend>
                <div className="flex flex-wrap items-center gap-2">
                  {SWATCHES.map((c) => (
                    <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={style.color === c} onClick={() => up("color", c)}
                      className={`size-8 rounded-full border-2 focus-visible:outline-2 focus-visible:outline-accent ${style.color === c ? "border-white" : "border-white/20"}`} style={{ background: c }} />
                  ))}
                  <label htmlFor={colorId} className="sr-only">Pick any color</label>
                  <input id={colorId} type="color" value={style.color} onChange={(e) => up("color", e.target.value)} className="size-8 cursor-pointer rounded-full border-0 bg-transparent p-0" />
                  <span className="text-xs text-faint">{style.color}</span>
                </div>
              </fieldset>
              <HexField value={style.color} onChange={(hex) => up("color", hex)} />
              <LogoField agentId={agentId} value={style.logo} onChange={(url) => up("logo", url)} />
              <Choice legend="Where on the screen" value={style.position} options={POSITIONS} onChange={(v) => up("position", v)} />
              <Choice legend="Shape" value={style.shape} options={SHAPES} onChange={(v) => up("shape", v)} />
              {style.shape === "orb" && <p className="-mt-2 text-sm text-muted">A small glowing sphere that gently pulses, so visitors can tell something is listening. Your words show beside it when someone points at it, and once when the page first loads.</p>}
              <Choice legend="Size" value={style.size} options={SIZES} onChange={(v) => up("size", v)} />
              {style.shape !== "orb" && <Choice legend="Look" value={style.look} options={LOOKS} onChange={(v) => up("look", v)} />}
              <Choice legend="Icon" value={style.icon} options={ICONS} onChange={(v) => up("icon", v)} />
              <Choice legend="Distance from the edge" value={style.edge} options={EDGES} onChange={(v) => up("edge", v)} />
            </>
          ) : (
            <>
              {([["width", "Width", 280, 900], ["height", "Height", 360, 900], ["radius", "Rounded corners", 0, 40]] as const).map(([k, label, lo, hi]) => (
                <div key={k}>
                  <label className="label" htmlFor={`${colorId}-${k}`}>{label}: {box[k]}{k === "radius" ? "" : " pixels"}</label>
                  <input id={`${colorId}-${k}`} type="range" min={lo} max={hi} value={box[k]} onChange={(e) => upBox(k, Number(e.target.value))} className="w-full accent-[var(--accent)]" />
                </div>
              ))}
              <p className="text-sm text-muted">The call box keeps its own dark look. Choose its size, and how round its corners are.</p>
            </>
          )}
          {changed && (
            <button type="button" className="btn btn-quiet" onClick={() => save({ style: DEFAULT_STYLE, box: DEFAULT_BOX })}>Reset to the defaults</button>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Choice legend="Preview on" value={device} options={["desktop", "mobile"] as const} onChange={setDevice} />
            <Choice legend="Page" value={backdrop} options={["light", "dark"] as const} onChange={setBackdrop} />
          </div>
          <div className="rounded-2xl border border-line bg-black/30 p-2">
            <iframe
              title="Preview of your website with the button on it"
              sandbox="allow-scripts"
              srcDoc={shownDoc}
              className={`mx-auto block h-[30rem] rounded-xl border-0 bg-white ${device === "mobile" ? "w-[375px] max-w-full" : "w-full"}`}
            />
          </div>
          <p className="text-xs text-faint">This is how it will look on a typical page. Click the button to see where the call box opens. In this preview, no call is started.</p>
        </div>
      </div>

      {mode === "button" ? (
        <CopyBox title="Your code: a floating button" hint="Paste this just before </body> on every page where the button should appear. It already includes your choices." code={scriptSnippet(appUrl, agentId, style)} />
      ) : (
        <CopyBox title="Your code: a call box built into the page" hint="Paste this where the call box should sit on the page." code={iframeSnippet(appUrl, agentId, box)} />
      )}
    </section>
  );
}
