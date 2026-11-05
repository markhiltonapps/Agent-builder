import assert from "node:assert/strict";
import { test } from "node:test";
import { cell, currentMonth, detailCsv, minutes, monthRange, parseMonth, summaryCsv, totals } from "./usage.ts";

test("only a real month is accepted", () => {
  assert.equal(parseMonth("2026-10"), "2026-10");
  for (const bad of ["2026-13", "2026-00", "26-10", "2026-1", "2026-10-01", "", undefined, null, "2019-12", "2101-01", "../x"]) assert.equal(parseMonth(bad as string), null, String(bad));
});

test("a month knows its first and last day and its neighbours", () => {
  assert.deepEqual(monthRange("2026-02"), { from: "2026-02-01", to: "2026-02-28", label: "February 2026", prev: "2026-01", next: "2026-03" });
  assert.equal(monthRange("2028-02").to, "2028-02-29");
  assert.equal(monthRange("2026-12").next, "2027-01");
  assert.equal(monthRange("2026-01").prev, "2025-12");
});

test("this month follows the person's clock, not the server's", () => {
  const edge = new Date("2026-11-01T03:30:00Z"); // still October in Texas
  assert.equal(currentMonth(edge, "America/Chicago"), "2026-10");
  assert.equal(currentMonth(edge, "UTC"), "2026-11");
});

test("minutes are shown to one decimal", () => {
  assert.equal(minutes(125), "2.1");
  assert.equal(minutes(0), "0.0");
  assert.equal(minutes(3600), "60.0");
});

const rows = [
  { account_id: "a", name: "Bright Smile Dental", calls: 3, seconds: 245, billable_minutes: 6, chats: 2 },
  { account_id: "b", name: '=HYPERLINK("x") & "Co", Inc', calls: 0, seconds: 0, billable_minutes: 0, chats: 0 },
];

test("totals add up every client", () => {
  assert.deepEqual(totals(rows), { calls: 3, seconds: 245, billable: 6, chats: 2 });
});

test("spreadsheet cells are quoted, and formulas are defused", () => {
  assert.equal(cell("plain"), "plain");
  assert.equal(cell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(cell("=1+1"), "'=1+1");
  assert.equal(cell("-5"), "'-5");
  assert.equal(cell(7), "7");
});

test("the summary CSV has a header, one row per client and a total", () => {
  const lines = summaryCsv(rows, "2026-10").trim().split("\r\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "Client,Month,Voice calls,Minutes,Billable minutes (each call rounded up),Chats");
  assert.equal(lines[1], "Bright Smile Dental,2026-10,3,4.1,6,2");
  assert.match(lines[2], /^"'=HYPERLINK\(""x""\) & ""Co"", Inc",/);
  assert.equal(lines[3], "Total,2026-10,3,4.1,6,2");
});

test("the detail CSV rounds each call up and leaves chats without minutes", () => {
  const csv = detailCsv(
    [
      { started_at: "2026-10-10T15:00:00Z", agent: "Front desk", source: "phone", channel: "voice", duration_s: 61 },
      { started_at: "2026-10-12T10:00:00Z", agent: "Front desk", source: "web", channel: "chat", duration_s: 300 },
    ],
    "UTC",
  ).trim().split("\r\n");
  assert.equal(csv[1], "2026-10-10 15:00:00,Front desk,Phone,Voice,61,1.0,2");
  assert.equal(csv[2], "2026-10-12 10:00:00,Front desk,Website,Chat,,,");
});
