// Structural diff between two JSON documents, reported as one row per changed leaf or
// array item. Arrays of strings and objects are compared by position, which matches how
// the editor shows them (an ordered list the person edits in place).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface Change {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: Json;
  after?: Json;
}

const isObject = (v: unknown): v is { [k: string]: Json } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function diffJson(before: Json | undefined, after: Json | undefined, path = ""): Change[] {
  if (before === undefined && after === undefined) return [];
  if (before === undefined) return [{ path, kind: "added", after }];
  if (after === undefined) return [{ path, kind: "removed", before }];

  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffJson(before[k], after[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: Change[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      out.push(...diffJson(before[i], after[i], `${path}[${i}]`));
    }
    return out;
  }
  return JSON.stringify(before) === JSON.stringify(after)
    ? []
    : [{ path, kind: "changed", before, after }];
}
