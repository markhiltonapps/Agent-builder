import assert from "node:assert/strict";
import { test } from "node:test";
import { friendlyName, labelFor } from "./labels.ts";

test("known fields use their on-screen names", () => {
  assert.equal(labelFor("persona.business_description"), "About the business");
  assert.equal(labelFor("greetings.opening"), "Opening line");
  assert.equal(labelFor("runtime.max_call_seconds"), "Longest call");
});

test("list items are numbered from 1 and name the field", () => {
  assert.equal(labelFor("guardrails.2"), "Rule 3");
  assert.equal(labelFor("escalation[0].condition"), "Handoff 1: when");
  assert.equal(labelFor("escalation.1.handoff_summary"), "Handoff 2: note for whoever takes over");
});

test("unknown paths are readable, not raw", () => {
  assert.equal(labelFor("something.odd_thing"), "something › odd thing");
  assert.equal(labelFor(""), "Settings");
});

test("friendlyName turns an action's code name into words", () => {
  assert.equal(friendlyName("check_service_area"), "Check service area");
  assert.equal(friendlyName("take_message"), "Take message");
});
