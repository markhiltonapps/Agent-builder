import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_LINKS, CLIENT_TABS, CLIENT_TOP_LINKS, isActive, levelOf } from "./nav.ts";

test("the pages of one client are inside a client; the rest are the admin level", () => {
  for (const p of ["/dashboard", "/agents", "/agents/new", "/agents/9bef4c7c-5c02-46fa-b325-f491a06c9d0c/talk", "/knowledge", "/knowledge/abc", "/calls", "/calls/abc", "/numbers", "/settings"]) {
    assert.equal(levelOf(p), "client", p);
  }
  for (const p of ["/clients", "/all-calls", "/usage", "/usage/export", "/help", "/login", "/"]) {
    assert.equal(levelOf(p), "all", p);
  }
});

test("a path that only starts like a client page is not one", () => {
  assert.equal(levelOf("/calls-archive"), "all");
  assert.equal(levelOf("/all-calls"), "all");
  assert.equal(levelOf("/agentsX"), "all");
});

test("every tab lands inside a client, and every admin link does not", () => {
  assert.ok(CLIENT_TABS.every((t) => levelOf(t.href) === "client"));
  assert.ok(ADMIN_LINKS.every((t) => levelOf(t.href) === "all"));
  assert.ok(CLIENT_TOP_LINKS.every((t) => levelOf(t.href) === "all"), "the way back up is not itself a client page");
});

test("a link is active on its own page and the pages beneath it, not on a look-alike", () => {
  assert.equal(isActive("/calls/abc", "/calls"), true);
  assert.equal(isActive("/calls", "/calls"), true);
  assert.equal(isActive("/all-calls", "/calls"), false);
  assert.equal(isActive("/agents/new", "/agents"), true);
});
