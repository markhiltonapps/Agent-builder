import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDays, percent, safeTimeZone, shortDay, spoken } from "./dashboard.ts";

test("only the offered periods are accepted", () => {
  assert.equal(parseDays("7"), 7);
  assert.equal(parseDays(["90"]), 90);
  assert.equal(parseDays("1000"), 30);
  assert.equal(parseDays(undefined), 30);
});

test("a rate needs calls to be a rate", () => {
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(0, 4), 0);
  assert.equal(percent(0, 0), null);
});

test("time zones are checked before use", () => {
  assert.equal(safeTimeZone("America/Phoenix"), "America/Phoenix");
  assert.equal(safeTimeZone("Not/AZone"), "UTC");
  assert.equal(safeTimeZone("x; drop table"), "UTC");
  assert.equal(safeTimeZone(undefined), "UTC");
});

test("totals read like speech", () => {
  assert.equal(spoken(0), "0 min");
  assert.equal(spoken(45), "45 sec");
  assert.equal(spoken(90), "1 min 30 sec");
  assert.equal(spoken(1500), "25 min");
  assert.equal(spoken(3725), "1 hr 2 min");
});

test("a day label ignores the viewer's time zone", () => {
  assert.equal(shortDay("2026-11-04"), "Nov 4");
  assert.equal(shortDay("2026-01-01"), "Jan 1");
});
