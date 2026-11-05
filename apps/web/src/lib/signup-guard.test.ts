import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BLOCKED_DOMAINS, checkSignupEmail, domainCanReceiveMail, isBlockedDomain, normalizeEmail } from "./signup-guard.ts";
import { assertSafeToSignUp } from "../../scripts/test-guard.mjs";

const mx = (...hosts: string[]) => async () => hosts.map((exchange) => ({ exchange }));
const fails = (code?: string) => async () => { throw Object.assign(new Error("dns"), { code }); };

test("test and unreachable domains are refused without a lookup", async () => {
  for (const e of ["a@example.com", "a@example.org", "b@tokbird.com", "c@mail.test", "d@x.invalid", "e@localhost", "f@nodot"]) {
    const r = await checkSignupEmail(e, fails());
    const noDot = e.endsWith("nodot") || e.endsWith("@localhost"); // refused as badly formed before the domain list
    assert.deepEqual(r, { ok: false, reason: noDot ? "format" : "blocked" }, e);
  }
});

test("badly formed addresses are refused", async () => {
  for (const e of ["", "plain", "a@b", "a b@c.com", "@c.com", "a@@c.com", "x".repeat(300) + "@c.com"]) {
    assert.equal((await checkSignupEmail(e, mx("mx.c.com"))).ok, false, e);
  }
});

test("a real-looking address on a domain with mail servers is accepted, and normalised", async () => {
  assert.deepEqual(await checkSignupEmail("  Mark.Allen+Test1@Gmail.com ", mx("gmail-smtp-in.l.google.com")), { ok: true, email: "mark.allen+test1@gmail.com" });
  assert.equal(normalizeEmail(" A@B.Com "), "a@b.com");
});

test("a domain with no mail servers is refused; a lookup that cannot finish is unverified, not accepted", async () => {
  assert.deepEqual(await checkSignupEmail("a@nomail-1.com", mx()), { ok: false, reason: "no_mail" });
  assert.deepEqual(await checkSignupEmail("a@nomail-2.com", fails("ENODATA")), { ok: false, reason: "no_mail" });
  assert.deepEqual(await checkSignupEmail("a@slow-1.com", fails("ESERVFAIL")), { ok: false, reason: "unverified" });
  assert.equal(await domainCanReceiveMail("slow-2.com", () => new Promise(() => {}), 20), "unverified");
});

test("blocked domains in the app match the ones the database hook refuses", () => {
  const sql = readFileSync(new URL("../../../../supabase/migrations/20261105080000_signup_hook.sql", import.meta.url), "utf8");
  for (const d of BLOCKED_DOMAINS) assert.ok(sql.includes(`'${d}'`), `the hook does not block ${d}`);
  for (const s of [".test", ".invalid", ".example", ".localhost"]) assert.ok(sql.includes(s.slice(1)), `the hook does not block ${s}`);
  assert.ok(isBlockedDomain("deep.sub.example.test"));
});

test("test scripts cannot sign up bad addresses, or anyone but the owner's inbox, on production", () => {
  const prod = "https://nstpotkzqgkyrvgkdpel.supabase.co";
  assert.throws(() => assertSafeToSignUp({ supabaseUrl: prod, email: "cltest1@tokbird.com" }), /cannot receive mail/);
  assert.throws(() => assertSafeToSignUp({ supabaseUrl: "http://localhost:54321", email: "x@example.com" }), /cannot receive mail/);
  assert.throws(() => assertSafeToSignUp({ supabaseUrl: prod, email: "someone@gmail.com" }), /production/);
  assert.throws(() => assertSafeToSignUp({ supabaseUrl: prod, email: "markallenhilton@gmail.com" }), /production/); // plus tag required
  assert.doesNotThrow(() => assertSafeToSignUp({ supabaseUrl: prod, email: "markallenhilton+test1@gmail.com" }));
  assert.doesNotThrow(() => assertSafeToSignUp({ supabaseUrl: "http://localhost:54321", email: "anyone@gmail.com" }));
});
