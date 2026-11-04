import assert from "node:assert/strict";
import { test } from "node:test";
import { duration } from "./format.ts";
import { formatNumber } from "./phone-format.ts";

test("formats call lengths", () => {
  assert.equal(duration(0), "0:00");
  assert.equal(duration(75), "1:15");
  assert.equal(duration(599.6), "10:00");
  assert.equal(duration(3725), "1:02:05");
  assert.equal(duration(-4), "0:00");
});

test("formats US numbers for people", () => {
  assert.equal(formatNumber("+16029150339"), "+1 (602) 915-0339");
  assert.equal(formatNumber("+442079460958"), "+442079460958");
});
