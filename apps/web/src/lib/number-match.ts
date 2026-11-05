// Finding a phone number by the digits you want in it. LiveKit's search only filters by area
// code, so we fetch a batch for each area code and pick the matches here.

export type Where = "anywhere" | "start" | "end";

/** "602, 480 623" -> ["602", "480", "623"]. At most three, each exactly three digits, no repeats. */
export function parseAreaCodes(text: string): { codes: string[]; bad: string[] } {
  const codes: string[] = [];
  const bad: string[] = [];
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    if (/^\d{3}$/.test(part)) {
      if (!codes.includes(part)) codes.push(part);
    } else bad.push(part);
  }
  return { codes: codes.slice(0, 3), bad };
}

/** The seven digits after the area code: +16027777123 -> "7777123". */
export const localDigits = (e164: string) => e164.replace(/\D/g, "").slice(-7);

/** Does the number have these digits where the person wants them? No digits matches everything. */
export function matchesDigits(e164: string, digits: string, where: Where): boolean {
  const want = digits.replace(/\D/g, "");
  if (!want) return true;
  const local = localDigits(e164);
  if (where === "start") return local.startsWith(want);
  if (where === "end") return local.endsWith(want);
  return local.includes(want);
}

/** Longer runs of one repeated digit read as "nicer" (7777 beats 7-1-7). Used to order matches. */
export function niceness(e164: string): number {
  const runs = localDigits(e164).match(/(\d)\1*/g) ?? [];
  return Math.max(0, ...runs.map((r) => r.length));
}
