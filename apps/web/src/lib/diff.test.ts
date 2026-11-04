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

test("lists of text compare by content: an insert does not make later items look changed", () => {
  assert.deepEqual(diffJson({ g: ["a", "b", "c"] }, { g: ["a", "x", "b", "c"] }), [
    { path: "g[1]", kind: "added", after: "x" },
  ]);
  assert.deepEqual(diffJson({ g: ["a", "b"] }, { g: ["a"] }), [
    { path: "g[1]", kind: "removed", before: "b" },
  ]);
  assert.deepEqual(diffJson({ g: ["a", "b"] }, { g: ["a", "c"] }), [
    { path: "g[1]", kind: "added", after: "c" },
    { path: "g[1]", kind: "removed", before: "b" },
  ]);
  assert.deepEqual(diffJson({ g: [] }, { g: ["a"] }), [{ path: "g[0]", kind: "added", after: "a" }]);
});

test("lists of objects still compare by position", () => {
  assert.deepEqual(diffJson({ e: [{ a: 1 }, { a: 2 }] }, { e: [{ a: 1 }, { a: 3 }, { a: 4 }] }), [
    { path: "e[1].a", kind: "changed", before: 2, after: 3 },
    { path: "e[2]", kind: "added", after: { a: 4 } },
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
