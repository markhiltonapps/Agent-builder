import assert from "node:assert/strict";
import { test } from "node:test";
import { CHUNK_MAX, chunkMarkdown, decodeText, fileProblem, prepareDocument, prepareText, scopeLabel, sizeLabel, titleFor } from "./knowledge.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

test("only small Markdown and text files are taken, with a reason in plain words", () => {
  assert.equal(fileProblem("faq.md", 100), null);
  assert.equal(fileProblem("Notes.TXT", 100), null);
  assert.equal(fileProblem("faq.markdown", 100), null);
  assert.match(fileProblem("menu.pdf", 100) ?? "", /only Markdown/);
  assert.match(fileProblem("empty.md", 0) ?? "", /empty/);
  assert.match(fileProblem("big.md", 300_000) ?? "", /up to 200 KB/);
});

test("text must be UTF-8; a byte-order mark and Windows line endings are tidied", () => {
  assert.deepEqual(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0d, 0x0a, 0x79])), { ok: true, text: "hi\ny" });
  assert.deepEqual(decodeText(new Uint8Array([0xff, 0xfe, 0x00])), { ok: false });
  assert.deepEqual(decodeText(bytes("a\u0000b")), { ok: false });
});

test("the title is the front matter title, else the first heading, else the file name", () => {
  assert.equal(titleFor('---\ntitle: "Opening hours"\ntags: a\n---\n# Other\nx', "a.md"), "Opening hours");
  assert.equal(titleFor("# Prices and fees\n\nCleaning is 99.", "a.md"), "Prices and fees");
  assert.equal(titleFor("Just some text first.\n\n# Later heading", "office-faq_2026.md"), "Office faq 2026");
  assert.equal(titleFor("```\n# not a heading\n```\ntext", "parking.txt"), "Parking");
});

test("passages carry the path of headings they sit under", () => {
  const md = "# Hours\n\nWe are open daily.\n\n## Weekend\n\nSaturday 9 to 1.\n\n## Holidays\n\nClosed on public holidays.\n\n# Prices\n\nCleaning is 99 dollars.";
  assert.deepEqual(chunkMarkdown(md), [
    { heading: "Hours", content: "We are open daily." },
    { heading: "Hours > Weekend", content: "Saturday 9 to 1." },
    { heading: "Hours > Holidays", content: "Closed on public holidays." },
    { heading: "Prices", content: "Cleaning is 99 dollars." },
  ]);
});

test("text with no headings is still searchable, and a heading with nothing under it is left out", () => {
  assert.deepEqual(chunkMarkdown("Plain text with no headings."), [{ heading: "", content: "Plain text with no headings." }]);
  assert.deepEqual(chunkMarkdown("# Empty\n\n# Full\n\nHere."), [{ heading: "Full", content: "Here." }]);
  assert.deepEqual(chunkMarkdown("---\ntitle: T\n---\nBody <!-- hidden note --> here."), [{ heading: "", content: "Body  here." }]);
});

test("a # inside a code block is not a heading", () => {
  const out = chunkMarkdown("# Setup\n\n```\n# comment\nrun it\n```\n\nDone.");
  assert.equal(out.length, 1);
  assert.equal(out[0].heading, "Setup");
  assert.match(out[0].content, /# comment/);
});

test("short paragraphs are packed together and long ones are cut, never past the limit", () => {
  const para = (n: number) => `Sentence number ${n} is here. `.repeat(8).trim();
  const many = Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n");
  const packed = chunkMarkdown(`# Long\n\n${many}`);
  assert.ok(packed.length > 1 && packed.length < 12, "packed into a few passages");
  assert.ok(packed.every((c) => c.content.length <= CHUNK_MAX && c.heading === "Long"));
  const one = chunkMarkdown(`# Wall\n\n${"word ".repeat(1000)}`);
  assert.ok(one.length >= 3 && one.every((c) => c.content.length <= CHUNK_MAX));
  assert.equal(one.map((c) => c.content).join(" ").split(/\s+/).length, 1000, "nothing is lost");
});

test("lists and tables stay together under their heading", () => {
  const md = "## Services\n\n- Cleaning\n- Whitening\n- Fillings\n\n| Service | Price |\n|---|---|\n| Cleaning | 99 |";
  const out = chunkMarkdown(md);
  assert.equal(out.length, 1);
  assert.match(out[0].content, /- Whitening[\s\S]*\| Cleaning \| 99 \|/);
});

test("an uploaded file becomes a title, the text and its passages, or a reason it cannot", () => {
  const ok = prepareDocument("hours.md", bytes("# Hours\n\nOpen 8 to 5."));
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.title, "Hours");
    assert.equal(ok.filename, "hours.md");
    assert.equal(ok.chunks.length, 1);
  }
  assert.equal(prepareDocument("x.pdf", bytes("x")).ok, false);
  assert.match((prepareDocument("x.md", new Uint8Array([0xff, 0xfe])) as { error: string }).error, /not a plain text file/);
  assert.match((prepareDocument("x.md", bytes("# Only a heading")) as { error: string }).error, /only headings/);
});

test("typed text needs a title and some text", () => {
  assert.equal(prepareText("  ", "", "text").ok, false);
  assert.equal(prepareText("Title", "", "   ").ok, false);
  const ok = prepareText("  Our   policies ", "", "Refunds within 30 days.\r\n");
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual([ok.title, ok.content], ["Our policies", "Refunds within 30 days."]);
});

test("who a document is for, in a few words", () => {
  const agents = [{ id: "a", name: "Front Desk" }, { id: "b", name: "Billing" }];
  assert.equal(scopeLabel(null, agents), "All agents");
  assert.equal(scopeLabel([], agents), "No agents");
  assert.equal(scopeLabel(["a"], agents), "Front Desk");
  assert.equal(scopeLabel(["a", "b"], agents), "All agents");
  assert.equal(scopeLabel(["a", "gone"], agents), "Front Desk");
  assert.equal(scopeLabel(["a"], [{ id: "a", name: "Only" }]), "Only");
  assert.equal(sizeLabel(450), "450 characters");
  assert.equal(sizeLabel(3200), "3.2 KB");
  assert.equal(sizeLabel(45_000), "45 KB");
});
