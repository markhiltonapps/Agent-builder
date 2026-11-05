import assert from "node:assert/strict";
import { test } from "node:test";
import { frameAncestors, isSameOrigin, isUuid, makeLimiter, normalizeSite, parseSites } from "./embed-code.ts";
import { iframeSnippet, scriptSnippet } from "./embed-style.ts";

test("a typed site becomes a clean origin", () => {
  assert.equal(normalizeSite("Example.com"), "https://example.com");
  assert.equal(normalizeSite("https://www.example.com/shop?x=1#top"), "https://www.example.com");
  assert.equal(normalizeSite("*.example.com"), "https://*.example.com");
  assert.equal(normalizeSite("https://example.com:8443/"), "https://example.com:8443");
  assert.equal(normalizeSite("http://localhost:3000/page"), "http://localhost:3000");
});

test("things that are not sites are refused", () => {
  for (const bad of ["", "  ", "http://example.com", "javascript:alert(1)", "https://exa mple.com", "https://", "*", "https://*", "ftp://example.com", "https://a.com; script-src *"]) {
    assert.equal(normalizeSite(bad), null, bad);
  }
});

test("a list is split, cleaned and de-duplicated, and bad lines are reported", () => {
  const r = parseSites("example.com\nhttps://Example.com/about, shop.example.org   nonsense!");
  assert.deepEqual(r.sites, ["https://example.com", "https://shop.example.org"]);
  assert.deepEqual(r.bad, ["nonsense!"]);
});

test("only valid sites can reach the frame header; a blank list means any site", () => {
  assert.equal(frameAncestors([]), "frame-ancestors *");
  assert.equal(frameAncestors(["https://example.com", "https://*.example.org"]), "frame-ancestors https://example.com https://*.example.org");
  assert.equal(frameAncestors(["https://example.com; script-src *", "bad"]), "frame-ancestors 'none'");
});

test("only our own pages may start a call", () => {
  assert.equal(isSameOrigin("https://app.test", "https://app.test"), true);
  assert.equal(isSameOrigin("https://evil.test", "https://app.test"), false);
  assert.equal(isSameOrigin(null, "https://app.test"), false);
  // the app can answer on two addresses; either one is ours
  assert.equal(isSameOrigin("https://old.test", ["https://new.test", "https://old.test"]), true);
  assert.equal(isSameOrigin("https://evil.test", ["https://new.test", "https://old.test"]), false);
});

test("the copied code points at the app and the agent", () => {
  const id = "9bef4c7c-5c02-46fa-b325-f491a06c9d0c";
  assert.equal(isUuid(id), true);
  assert.equal(isUuid("nope"), false);
  assert.equal(scriptSnippet("https://app.test/", id), `<script src="https://app.test/embed.js" data-agent="${id}" data-label="Talk to us" async></script>`);
  assert.match(scriptSnippet("https://app.test", id, 'Hi "<b>"'), /data-label="Hi b"/);
  assert.match(iframeSnippet("https://app.test", id), /src="https:\/\/app\.test\/embed\/9bef4c7c.*allow="microphone; autoplay"/);
});

test("the limiter allows a few hits per window and then recovers", () => {
  let t = 0;
  const ok = makeLimiter(2, 1000, () => t);
  assert.equal(ok("a"), true);
  assert.equal(ok("a"), true);
  assert.equal(ok("a"), false);
  assert.equal(ok("b"), true); // someone else is unaffected
  t = 1500;
  assert.equal(ok("a"), true);
});
