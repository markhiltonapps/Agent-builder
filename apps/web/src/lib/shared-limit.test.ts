import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedLimiter, type Hit } from "./shared-limit.ts";

test("the count comes from the shared store, so two limiters (two copies) see the same visitor", async () => {
  const counts = new Map<string, number>();
  const hit: Hit = async (key, max) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n <= max;
  };
  const copyA = sharedLimiter("chat", 2, 60_000, hit);
  const copyB = sharedLimiter("chat", 2, 60_000, hit);
  assert.equal(await copyA("1.2.3.4"), true);
  assert.equal(await copyB("1.2.3.4"), true);
  assert.equal(await copyA("1.2.3.4"), false);
  assert.equal(await copyB("1.2.3.4"), false);
  assert.equal(await copyB("9.9.9.9"), true); // someone else is unaffected
});

test("limits with different names do not share a count, and the window is sent in seconds", async () => {
  const seen: Array<[string, number, number]> = [];
  const hit: Hit = async (key, max, windowS) => (seen.push([key, max, windowS]), true);
  await sharedLimiter("send", 30, 60_000, hit)("v");
  await sharedLimiter("start", 8, 600_000, hit)("v");
  assert.deepEqual(seen, [["send:v", 30, 60], ["start:v", 8, 600]]);
});

test("if the shared store cannot be reached, this copy counts for itself", async () => {
  const down: Hit = async () => null;
  const limit = sharedLimiter("chat", 2, 60_000, down);
  assert.equal(await limit("a"), true);
  assert.equal(await limit("a"), true);
  assert.equal(await limit("a"), false);
  assert.equal(await limit("b"), true);
});
