// The knowledge base: reading an uploaded Markdown (or plain text) file, and cutting it into the
// short passages an agent can search. Pure functions, so they can be tested without a browser or a
// database. The database holds the result (see supabase/migrations/..._knowledge.sql).

export const MAX_FILE_BYTES = 2_000_000;
/** A file longer than this is stored as several documents, cut at headings, so none is unwieldy to read or edit. */
export const PART_CHARS = 150_000;
export const ALLOWED_EXTENSIONS = [".md", ".markdown", ".txt"] as const;
/** A passage aims to be about this long, and never goes past the maximum (the database allows 4000). */
export const CHUNK_TARGET = 900;
export const CHUNK_MAX = 1400;

export interface Chunk { heading: string; content: string }

export interface PreparedDoc { title: string; filename: string; content: string; chunks: Chunk[] }

export type Prepared = ({ ok: true } & PreparedDoc) | { ok: false; error: string };

const fileKb = (bytes: number) => (bytes >= 1_000_000 ? `${+(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`);

/** Whether a file by this name and size can be taken, or why not, in words for the person. */
export function fileProblem(name: string, size: number): string | null {
  const lower = name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((e) => lower.endsWith(e))) return `${name}: only Markdown (.md) and plain text (.txt) files can be added.`;
  if (size === 0) return `${name} is empty.`;
  if (size > MAX_FILE_BYTES) return `${name} is ${fileKb(size)}. A file can be up to ${fileKb(MAX_FILE_BYTES)}. Split it into two or more files.`;
  return null;
}

/** The text of a file as UTF-8, with Windows line endings and a byte-order mark tidied up. */
export function decodeText(bytes: Uint8Array): { ok: true; text: string } | { ok: false } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false };
  }
  if (text.includes("\u0000")) return { ok: false };
  return { ok: true, text: text.replace(/^﻿/, "").replace(/\r\n?/g, "\n") };
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

function splitFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = FRONT_MATTER.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function prettyName(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ").trim();
  return base ? base[0].toUpperCase() + base.slice(1) : "Untitled";
}

/** A document's title: its front matter title, else its first heading, else its file name. */
export function titleFor(text: string, filename: string): string {
  const { meta, body } = splitFrontMatter(text);
  if (meta.title) return meta.title.slice(0, 200);
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h = !fenced && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) return h[1].slice(0, 200);
    if (line.trim() && !fenced) break; // text before any heading: the file name is a better title
  }
  return prettyName(filename).slice(0, 200);
}

/** A long paragraph, cut at sentence ends where it can, and at spaces where it cannot. */
function splitLong(paragraph: string): string[] {
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > CHUNK_MAX) {
    const window = rest.slice(0, CHUNK_MAX);
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "), window.lastIndexOf("\n"));
    const space = window.lastIndexOf(" ");
    const cut = sentence > CHUNK_MAX / 3 ? sentence + 1 : space > CHUNK_MAX / 3 ? space : CHUNK_MAX;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Cut a document into passages: one section at a time, each passage under its heading path. */
export function chunkMarkdown(text: string): Chunk[] {
  const { body } = splitFrontMatter(text);
  const clean = body.replace(/<!--[\s\S]*?-->/g, "");
  const chunks: Chunk[] = [];
  const path: Array<{ level: number; text: string }> = [];
  let buffer: string[] = [];
  let fenced = false;

  const flush = () => {
    const heading = path.map((p) => p.text).join(" > ").slice(0, 300);
    const paragraphs = buffer.join("\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    buffer = [];
    let current = "";
    const push = () => {
      if (current.trim()) chunks.push({ heading, content: current.trim() });
      current = "";
    };
    for (const p of paragraphs) {
      for (const piece of p.length > CHUNK_MAX ? splitLong(p) : [p]) {
        if (current && current.length + piece.length + 2 > CHUNK_TARGET) push();
        current = current ? `${current}\n\n${piece}` : piece;
      }
    }
    push();
  };

  for (const line of clean.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h = !fenced && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      while (path.length && path[path.length - 1].level >= level) path.pop();
      path.push({ level, text: h[2].trim() });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return chunks;
}

const HEADING = (level: number) => new RegExp(`^#{${level}}\\s+\\S`);

/** Cut text into the pieces that start at a heading of this level (not inside a code block). */
function splitAtHeadings(text: string, level: number): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && HEADING(level).test(line) && current.some((l) => l.trim())) {
      out.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.some((l) => l.trim())) out.push(current.join("\n"));
  return out;
}

/** Last resort for text with no headings at all: cut at a blank line, else at a space. */
function splitPlain(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > PART_CHARS) {
    const window = rest.slice(0, PART_CHARS);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > PART_CHARS / 3 ? cut : PART_CHARS;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/** Pieces of at most PART_CHARS, cut at the biggest headings first (# then ## then ###), each piece whole. */
function pieces(text: string, level = 1): string[] {
  if (text.length <= PART_CHARS) return [text.trim()];
  if (level > 3) return splitPlain(text);
  const units = splitAtHeadings(text, level);
  if (units.length < 2) return pieces(text, level + 1);
  const out: string[] = [];
  let current = "";
  for (const unit of units.flatMap((u) => (u.length > PART_CHARS ? pieces(u, level + 1) : [u]))) {
    if (current && current.length + unit.length + 2 > PART_CHARS) {
      out.push(current.trim());
      current = "";
    }
    current = current ? `${current}\n\n${unit}` : unit;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** A long document as several, each under its own numbered title. A short one stays as it is. */
export function splitDocument(title: string, text: string): Array<{ title: string; content: string }> {
  const parts = pieces(text.trim());
  if (parts.length <= 1) return [{ title, content: text.trim() }];
  return parts.map((content, i) => {
    const tail = ` (part ${i + 1} of ${parts.length})`;
    return { title: `${title.slice(0, 200 - tail.length)}${tail}`, content };
  });
}

export type PreparedUpload = { ok: true; docs: PreparedDoc[] } | { ok: false; error: string };

/** Everything the database needs from an uploaded file: one document, or several if it is long. */
export function prepareUpload(filename: string, bytes: Uint8Array): PreparedUpload {
  const problem = fileProblem(filename, bytes.byteLength);
  if (problem) return { ok: false, error: problem };
  const decoded = decodeText(bytes);
  if (!decoded.ok) return { ok: false, error: `${filename} is not a plain text file. Save it as Markdown or text (UTF-8) and try again.` };
  const text = decoded.text;
  // A long file's front matter would only ride along on the first part, so it is dropped (its title is kept).
  const body = text.length > PART_CHARS ? text.replace(FRONT_MATTER, "") : text;
  const docs: PreparedDoc[] = [];
  for (const part of splitDocument(titleFor(text, filename), body)) {
    const prepared = prepareText(part.title, filename, part.content);
    if (!prepared.ok) return { ok: false, error: `${filename}: ${prepared.error}` };
    docs.push(prepared);
  }
  return { ok: true, docs };
}

/** One document from a file's bytes (kept for short files and tests). */
export function prepareDocument(filename: string, bytes: Uint8Array): Prepared {
  const r = prepareUpload(filename, bytes);
  return r.ok ? { ok: true, ...r.docs[0] } : r;
}

/** The same for text typed or edited in the page. */
export function prepareText(title: string, filename: string, text: string): Prepared {
  const content = text.replace(/\r\n?/g, "\n").trim();
  const t = title.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!t) return { ok: false, error: "Give the document a title." };
  if (!content) return { ok: false, error: "There is nothing in the document yet." };
  if (content.length > 200_000) return { ok: false, error: "That is too long for one document. Split it into smaller ones." };
  const chunks = chunkMarkdown(content);
  if (!chunks.length) return { ok: false, error: "There is no text in the document, only headings." };
  if (chunks.length > 2000) return { ok: false, error: "That is too long for one document. Split it into smaller ones." };
  return { ok: true, title: t, filename: filename.slice(0, 200), content, chunks };
}

/** Who uses a document, in a few words: always the client's own agents, never anyone else's. */
export function scopeLabel(agentIds: string[] | null, agents: Array<{ id: string; name: string }>, clientName = "this client"): string {
  const all = `All ${clientName} agents`;
  if (agentIds === null) return agents.length ? all : "No agents yet";
  const known = agents.filter((a) => agentIds.includes(a.id));
  if (known.length === 0) return "No agents";
  if (known.length === agents.length && agents.length > 1) return all;
  return known.length === 1 ? known[0].name : `${known.length} of ${agents.length} agents`;
}

/** "3 KB" for a document's size. */
export function sizeLabel(chars: number): string {
  return chars < 1000 ? `${chars} characters` : `${(chars / 1000).toFixed(chars < 10_000 ? 1 : 0)} KB`;
}
