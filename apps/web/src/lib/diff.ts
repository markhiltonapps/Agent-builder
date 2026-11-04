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
    // A list of plain text (rules): an inserted or removed item must not make every later
    // item look changed, so compare by content, not by position.
    if (before.every((x) => typeof x === "string") && after.every((x) => typeof x === "string")) {
      return diffText(before as string[], after as string[], path);
    }
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

/** Longest-common-subsequence diff of two lists of strings. */
function diffText(before: string[], after: string[], path: string): Change[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Change[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push({ path: `${path}[${j}]`, kind: "added", after: after[j] });
      j++;
    } else {
      out.push({ path: `${path}[${i}]`, kind: "removed", before: before[i] });
      i++;
    }
  }
  return out;
}
