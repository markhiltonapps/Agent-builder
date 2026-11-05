import assert from "node:assert/strict";
import { test } from "node:test";
import { localDigits, matchesDigits, niceness, parseAreaCodes } from "./number-match.ts";

test("area codes are cleaned, limited to three and de-duplicated", () => {
  assert.deepEqual(parseAreaCodes("602, 480 623 602 520"), { codes: ["602", "480", "623"], bad: [] });
  assert.deepEqual(parseAreaCodes("60, abc, 602"), { codes: ["602"], bad: ["60", "abc"] });
  assert.deepEqual(parseAreaCodes("  "), { codes: [], bad: [] });
});

test("only the seven digits after the area code are matched", () => {
  assert.equal(localDigits("+16027777123"), "7777123");
  // 602 in the area code must not count as "602" in the number
  assert.equal(matchesDigits("+16025551234", "602", "anywhere"), false);
  assert.equal(matchesDigits("+16025551234", "555", "anywhere"), true);
});

test("digits can be asked for anywhere, at the start or at the end", () => {
  const n = "+16027771234";
  assert.equal(matchesDigits(n, "777", "anywhere"), true);
  assert.equal(matchesDigits(n, "777", "start"), true);
  assert.equal(matchesDigits(n, "777", "end"), false);
  assert.equal(matchesDigits(n, "1234", "end"), true);
  assert.equal(matchesDigits(n, "771", "start"), false);
});

test("punctuation typed in the box is ignored, and no digits matches everything", () => {
  assert.equal(matchesDigits("+16027771234", "777-1", "anywhere"), true);
  assert.equal(matchesDigits("+16027771234", "", "end"), true);
  assert.equal(matchesDigits("+16027771234", "   ", "start"), true);
});

test("a run of the same digit ranks higher", () => {
  assert.ok(niceness("+16027777123") > niceness("+16027171234"));
  assert.equal(niceness("+16027777777"), 7);
});
