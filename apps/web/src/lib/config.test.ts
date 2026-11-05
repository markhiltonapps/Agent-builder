import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentConfig, withDefaults } from "./config.ts";

const bare = {
  schema_version: 1,
  persona: { agent_name: "Sam", business_name: "Acme", business_description: "", tone: "warm", languages: ["en"], bot_disclosure: "", timezone: "America/Chicago" },
  greetings: { opening: "Hi {business}", still_there: "Still there?", goodbye: "Bye" },
} as unknown as Partial<AgentConfig>;

test("a stored agent with only the required parts gets the defaults the editor relies on", () => {
  const c = withDefaults(bare);
  assert.deepEqual(c.tools, []);
  assert.deepEqual(c.adapters, {});
  assert.deepEqual(c.guardrails, []);
  assert.deepEqual(c.escalation, []);
  assert.equal(c.policy.interruption, "yield_immediately");
  assert.equal(c.runtime.max_call_seconds, 900);
  assert.equal(c.runtime.voice.voice, "marin");
  assert.equal(Object.values(c.adapters).length, 0); // the call that used to crash
});

test("what the agent already has is never overwritten", () => {
  const c = withDefaults({ ...bare, guardrails: ["Never promise a price."], runtime: { max_call_seconds: 300, voice: { provider: "openai", model: "gpt-live-1", voice: "cedar" } } } as unknown as Partial<AgentConfig>);
  assert.deepEqual(c.guardrails, ["Never promise a price."]);
  assert.equal(c.runtime.max_call_seconds, 300);
  assert.equal(c.runtime.voice.voice, "cedar");
  assert.equal(c.runtime.silence_timeout_seconds, 15);
});
