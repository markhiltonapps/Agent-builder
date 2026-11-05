import assert from "node:assert/strict";
import { test } from "node:test";
import { LIBRARY, applyTemplate, findTemplate, handoffLines, neverLines } from "./template-library.ts";

test("the library has the starting set, with unique keys", () => {
  const keys = LIBRARY.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of ["general", "auto-repair", "dental", "home-services"]) assert.ok(findTemplate(k), k);
});

test("every template can be shown and used", () => {
  for (const t of LIBRARY) {
    assert.ok(t.label && t.icon && t.blurb && t.handles.length >= 3, t.key);
    assert.ok(t.config.greetings.opening.includes("{business}"), t.key);
    assert.equal(t.config.persona.business_name, "Your business", t.key);
    assert.ok(handoffLines(t.config).length >= 2, `${t.key} should hand off urgent calls and requests for a person`);
    assert.ok(neverLines(t.config).length >= 3, t.key);
  }
});

test("customising sets the business, its description and time zone without touching the template", () => {
  const t = findTemplate("dental")!;
  const before = JSON.stringify(t.config);
  const c = applyTemplate(t.config, { businessName: "  Bright Smile Dental ", description: " Two-dentist practice. ", timezone: "America/Phoenix" });
  assert.equal(c.persona.business_name, "Bright Smile Dental");
  assert.equal(c.persona.business_description, "Two-dentist practice.");
  assert.equal(c.persona.timezone, "America/Phoenix");
  assert.equal(JSON.stringify(t.config), before);
  assert.equal(c.guardrails.length, t.config.guardrails.length);
});

test("over-long input is cut to what the agent allows", () => {
  const c = applyTemplate(findTemplate("general")!.config, { businessName: "x".repeat(500), description: "y".repeat(5000), timezone: "America/Chicago" });
  assert.equal(c.persona.business_name.length, 200);
  assert.equal(c.persona.business_description.length, 1000);
});
