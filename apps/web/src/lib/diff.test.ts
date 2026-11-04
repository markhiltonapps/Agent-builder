import assert from "node:assert/strict";
import { test } from "node:test";
import { diffJson } from "./diff.ts";

test("identical documents have no changes", () => {
  assert.deepEqual(diffJson({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 }), []);
});

test("reports changed, added and removed leaves with dotted paths", () => {
  const got = diffJson(
    { persona: { tone: "warm", name: "Riley" }, old: 1 },
    { persona: { tone: "calm", name: "Riley" }, fresh: true },
  );
  assert.deepEqual(got, [
    { path: "fresh", kind: "added", after: true },
    { path: "old", kind: "removed", before: 1 },
    { path: "persona.tone", kind: "changed", before: "warm", after: "calm" },
  ]);
});

test("arrays compare by position and report appended or dropped items", () => {
  const got = diffJson({ g: ["a", "b"] }, { g: ["a", "c", "d"] });
  assert.deepEqual(got, [
    { path: "g[1]", kind: "changed", before: "b", after: "c" },
    { path: "g[2]", kind: "added", after: "d" },
  ]);
  assert.deepEqual(diffJson({ g: ["a", "b"] }, { g: ["a"] }), [
    { path: "g[1]", kind: "removed", before: "b" },
  ]);
});

test("a type change is one change, not a walk into the old shape", () => {
  assert.deepEqual(diffJson({ x: { y: 1 } }, { x: [1] }), [
    { path: "x", kind: "changed", before: { y: 1 }, after: [1] },
  ]);
});

test("null is a value, distinct from absent", () => {
  assert.deepEqual(diffJson({ x: null }, {}), [{ path: "x", kind: "removed", before: null }]);
  assert.deepEqual(diffJson({ x: null }, { x: 0 }), [
    { path: "x", kind: "changed", before: null, after: 0 },
  ]);
});
