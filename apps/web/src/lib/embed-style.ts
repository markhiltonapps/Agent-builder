// The look of the website button, and the code that carries it. The Put on website page designs
// the button with these; public/embed.js reads the same choices from data- attributes.

export const POSITIONS = ["bottom-right", "bottom-left", "bottom-center", "top-right", "top-left", "top-center"] as const;
export const SHAPES = ["pill", "rounded", "square", "circle", "orb"] as const;
export const SIZES = ["small", "medium", "large"] as const;
export const LOOKS = ["solid", "glass", "outline"] as const;
export const ICONS = ["none", "mic", "phone", "chat"] as const;
export const EDGES = ["tight", "normal", "roomy"] as const;

export interface ButtonStyle {
  label: string;
  position: (typeof POSITIONS)[number];
  shape: (typeof SHAPES)[number];
  size: (typeof SIZES)[number];
  look: (typeof LOOKS)[number];
  icon: (typeof ICONS)[number];
  edge: (typeof EDGES)[number];
  color: string;
  /** A small picture shown on the button (an https address), or "" for none. */
  logo: string;
}

export const DEFAULT_STYLE: ButtonStyle = {
  label: "Talk to us", position: "bottom-right", shape: "pill", size: "medium",
  look: "solid", icon: "none", edge: "normal", color: "#0f766e", logo: "",
};

export const SWATCHES = ["#0f766e", "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#16a34a", "#111827", "#ffffff"];

/** A colour typed by hand: "#0f766e", "0f766e" or "#0fe" all work. Returns "#rrggbb", or null. */
export function parseHex(input: string): string | null {
  const t = input.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(t)) return `#${[...t].map((c) => c + c).join("")}`.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(t)) return `#${t}`.toLowerCase();
  return null;
}

/** Only a plain https address with no spaces or quotes can become the button's picture. */
export const LOGO_PATTERN = /^https:\/\/[^\s"'<>\\]{1,290}$/;

const oneOf = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/** Anything that isn't a known choice goes back to the default, so odd input can't reach the code. */
export function normalizeStyle(p: Partial<Record<keyof ButtonStyle, unknown>> = {}): ButtonStyle {
  const label = String(p.label ?? DEFAULT_STYLE.label).replace(/[<>"&]/g, "").trim().slice(0, 40) || DEFAULT_STYLE.label;
  const color = typeof p.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color.toLowerCase() : DEFAULT_STYLE.color;
  const logo = typeof p.logo === "string" && LOGO_PATTERN.test(p.logo.trim()) ? p.logo.trim() : "";
  return {
    label, color, logo,
    position: oneOf(POSITIONS, p.position, DEFAULT_STYLE.position),
    shape: oneOf(SHAPES, p.shape, DEFAULT_STYLE.shape),
    size: oneOf(SIZES, p.size, DEFAULT_STYLE.size),
    look: oneOf(LOOKS, p.look, DEFAULT_STYLE.look),
    icon: oneOf(ICONS, p.icon, DEFAULT_STYLE.icon),
    edge: oneOf(EDGES, p.edge, DEFAULT_STYLE.edge),
  };
}

/** The data- attributes for the script tag: only what differs from the defaults, plus the label. */
export function styleAttrs(style: Partial<ButtonStyle>): string {
  const s = normalizeStyle(style);
  const out = [`data-label="${s.label}"`];
  if (s.position !== DEFAULT_STYLE.position) out.push(`data-position="${s.position}"`);
  if (s.shape !== DEFAULT_STYLE.shape) out.push(`data-shape="${s.shape}"`);
  if (s.size !== DEFAULT_STYLE.size) out.push(`data-size="${s.size}"`);
  if (s.look !== DEFAULT_STYLE.look) out.push(`data-style="${s.look}"`);
  if (s.icon !== DEFAULT_STYLE.icon) out.push(`data-icon="${s.icon}"`);
  if (s.edge !== DEFAULT_STYLE.edge) out.push(`data-edge="${s.edge}"`);
  if (s.color !== DEFAULT_STYLE.color) out.push(`data-color="${s.color}"`);
  if (s.logo) out.push(`data-logo="${s.logo}"`);
  return out.join(" ");
}

/** Dark text on a light colour, white on a dark one. */
export function readableText(hex: string): "#ffffff" | "#0b0d14" {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b0d14" : "#ffffff";
}

export interface BoxStyle { width: number; height: number; radius: number }
export const DEFAULT_BOX: BoxStyle = { width: 380, height: 560, radius: 16 };
const clamp = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
export const normalizeBox = (b: Partial<Record<keyof BoxStyle, unknown>> = {}): BoxStyle => ({
  width: clamp(b.width, 280, 900, DEFAULT_BOX.width),
  height: clamp(b.height, 360, 900, DEFAULT_BOX.height),
  radius: clamp(b.radius, 0, 40, DEFAULT_BOX.radius),
});

export function scriptSnippet(appUrl: string, agentId: string, style: string | Partial<ButtonStyle> = {}): string {
  const base = appUrl.replace(/\/$/, "");
  const attrs = styleAttrs(typeof style === "string" ? { label: style } : style);
  return `<script src="${base}/embed.js" data-agent="${agentId}" ${attrs} async></script>`;
}

export function iframeSnippet(appUrl: string, agentId: string, box: Partial<BoxStyle> = {}): string {
  const base = appUrl.replace(/\/$/, "");
  const b = normalizeBox(box);
  return `<iframe src="${base}/embed/${agentId}" title="Talk to our AI assistant" width="${b.width}" height="${b.height}" style="border:0;border-radius:${b.radius}px" allow="microphone; autoplay" referrerpolicy="origin"></iframe>`;
}

export type Device = "desktop" | "mobile";
export type Backdrop = "light" | "dark";

/**
 * A stand-in web page for the preview. It runs the real embed.js in preview mode (so the button is
 * exactly what visitors get, but opening it shows a note instead of starting a call), or shows the
 * built-in call box as a placeholder of the chosen size.
 */
export function previewDocument(o: { appUrl: string; agentId: string; mode: "button" | "box"; style: Partial<ButtonStyle>; box: Partial<BoxStyle>; backdrop: Backdrop }): string {
  const dark = o.backdrop === "dark";
  const bg = dark ? "#10131c" : "#ffffff", fg = dark ? "#e8eaf2" : "#1c2230", line = dark ? "#262b3a" : "#e5e8ef";
  const bar = (w: number) => `<div style="height:10px;width:${w}%;background:${line};border-radius:6px;margin:10px 0"></div>`;
  const page = `<header style="display:flex;gap:18px;align-items:center;padding:16px 24px;border-bottom:1px solid ${line}"><b>Your Website</b><span style="opacity:.6">Home</span><span style="opacity:.6">Services</span><span style="opacity:.6">Contact</span></header>
    <main style="padding:28px 24px;max-width:720px"><h1 style="font-size:26px;margin:0 0 10px">Welcome to your business</h1>${bar(92)}${bar(84)}${bar(70)}<div style="height:90px;background:${line};border-radius:12px;margin:22px 0"></div>${bar(88)}${bar(60)}</main>`;
  const b = normalizeBox(o.box);
  const tail =
    o.mode === "button"
      ? `<script src="${o.appUrl.replace(/\/$/, "")}/embed.js" data-agent="${o.agentId}" data-preview="true" ${styleAttrs(o.style)}></script>`
      : `<div style="margin:0 24px 24px;width:${b.width}px;max-width:calc(100% - 48px);height:${Math.min(b.height, 520)}px;border-radius:${b.radius}px;background:#0b0d14;color:#c4cadc;display:grid;place-items:center;text-align:center;padding:20px;font:500 14px/1.5 system-ui;border:1px solid ${line}">The call box sits here, ${b.width} by ${b.height}.</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:${bg};color:${fg};font:15px/1.5 system-ui,sans-serif}</style></head><body>${page}${tail}</body></html>`;
}
