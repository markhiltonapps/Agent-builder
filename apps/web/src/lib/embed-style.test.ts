import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_STYLE, parseHex, EDGES, ICONS, LOOKS, POSITIONS, SHAPES, SIZES, iframeSnippet, normalizeBox, normalizeStyle, previewDocument, readableText, scriptSnippet, styleAttrs } from "./embed-style.ts";

const ID = "9bef4c7c-5c02-46fa-b325-f491a06c9d0c";

test("anything that is not a known choice falls back to the default", () => {
  const s = normalizeStyle({ position: "middle", shape: 5, color: "red", size: "huge", label: '  <b>Hi</b> "there"  ' });
  assert.deepEqual({ ...s, label: undefined }, { ...DEFAULT_STYLE, label: undefined });
  assert.equal(s.label, "bHi/b there");
  assert.equal(normalizeStyle({ label: "   " }).label, DEFAULT_STYLE.label);
  assert.equal(normalizeStyle({ color: "#ABCDEF" }).color, "#abcdef");
  assert.equal(normalizeStyle({ label: "x".repeat(100) }).label.length, 40);
});

test("the code only carries what you changed, plus the label", () => {
  assert.equal(styleAttrs({}), 'data-label="Talk to us"');
  assert.equal(
    styleAttrs({ label: "Call now", position: "top-left", shape: "circle", size: "large", look: "glass", icon: "phone", edge: "roomy", color: "#2563eb" }),
    'data-label="Call now" data-position="top-left" data-shape="circle" data-size="large" data-style="glass" data-icon="phone" data-edge="roomy" data-color="#2563eb"',
  );
  assert.equal(styleAttrs({ shape: "rounded" }), 'data-label="Talk to us" data-shape="rounded"');
});

test("the snippets use the app address and the agent", () => {
  assert.equal(scriptSnippet("https://bots.test/", ID), `<script src="https://bots.test/embed.js" data-agent="${ID}" data-label="Talk to us" async></script>`);
  assert.match(scriptSnippet("https://bots.test", ID, { position: "top-center" }), /data-position="top-center" async>/);
  assert.match(iframeSnippet("https://bots.test", ID, { width: 5000, height: 10, radius: -4 }), /width="900" height="360" style="border:0;border-radius:0px"/);
  assert.deepEqual(normalizeBox({ width: "abc" }), { width: 380, height: 560, radius: 16 });
});

test("text is dark on a light button and white on a dark one", () => {
  assert.equal(readableText("#ffffff"), "#0b0d14");
  assert.equal(readableText("#facc15"), "#0b0d14");
  assert.equal(readableText("#0f766e"), "#ffffff");
  assert.equal(readableText("#111827"), "#ffffff");
});

test("the preview runs the real script in preview mode, so no call can start", () => {
  const doc = previewDocument({ appUrl: "https://bots.test", agentId: ID, mode: "button", style: { shape: "square", color: "#db2777" }, box: {}, backdrop: "dark" });
  assert.match(doc, /embed\.js" data-agent="9bef4c7c[^"]*" data-preview="true" data-label="Talk to us" data-shape="square" data-color="#db2777"/);
  assert.match(doc, /#10131c/);
  const box = previewDocument({ appUrl: "https://bots.test", agentId: ID, mode: "box", style: {}, box: { width: 500, height: 600, radius: 8 }, backdrop: "light" });
  assert.match(box, /width:500px/);
  assert.doesNotMatch(box, /<script/);
});

test("embed.js understands every choice the designer can write", () => {
  const js = readFileSync(new URL("../../public/embed.js", import.meta.url), "utf8");
  for (const v of [...POSITIONS, ...SHAPES, ...SIZES, ...LOOKS, ...ICONS, ...EDGES]) assert.ok(js.includes(`"${v}"`), `embed.js does not know "${v}"`);
  for (const attr of ["data-label", "data-position", "data-shape", "data-size", "data-style", "data-icon", "data-edge", "data-color", "data-logo", "data-preview"]) assert.ok(js.includes(attr), attr);
  // a colour is only ever used if it is a plain #rrggbb
  assert.ok(js.includes("^#[0-9a-f]{6}$"));
  // a picture is only ever used if it is a plain https address
  assert.ok(js.includes("^https:"));
});

test("a typed colour is accepted with or without the #, and short forms are widened", () => {
  assert.equal(parseHex("#0F766E"), "#0f766e");
  assert.equal(parseHex("  2563eb "), "#2563eb");
  assert.equal(parseHex("#0fe"), "#00ffee");
  assert.equal(parseHex("blue"), null);
  assert.equal(parseHex("#12345"), null);
  assert.equal(parseHex(""), null);
});

test("the orb and the logo make it into the code, and only safe pictures do", () => {
  const url = "https://abc.supabase.co/storage/v1/object/public/embed-logos/x/y.png";
  assert.equal(styleAttrs({ shape: "orb", logo: url }), `data-label="Talk to us" data-shape="orb" data-logo="${url}"`);
  for (const bad of ["http://x.test/a.png", "javascript:alert(1)", 'https://x.test/a.png" onerror="x', "https://x.test/a b.png", "https://" + "x".repeat(400)]) {
    assert.equal(normalizeStyle({ logo: bad }).logo, "", bad);
  }
  assert.equal(normalizeStyle({}).logo, "");
});
