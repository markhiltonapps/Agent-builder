import assert from "node:assert/strict";
import { test } from "node:test";
import { nearBottom } from "./use-sticky-scroll.ts";

test("a box at the bottom keeps following new lines", () => {
  assert.equal(nearBottom(1000, 600, 400), true); // exactly at the bottom
  assert.equal(nearBottom(1000, 570, 400), true); // a line or so above still counts
});

test("scrolling up to read lets go, so new lines do not yank the reader back", () => {
  assert.equal(nearBottom(1000, 300, 400), false);
  assert.equal(nearBottom(1000, 0, 400), false);
});

test("a box with nothing to scroll is always at the bottom", () => {
  assert.equal(nearBottom(300, 0, 400), true);
});
