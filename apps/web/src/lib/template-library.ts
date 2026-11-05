import library from "./templates/library.json" with { type: "json" };
import type { AgentConfig } from "./config";

// The ready-made agents. Written in Python (apps/agent/src/agent_builder/template_specs) and
// copied here by `npm run sync-templates`, so there is one source for each.

export interface TemplateEntry {
  key: string;
  label: string;
  icon: string;
  blurb: string;
  handles: string[];
  asks: string[];
  handsOff: boolean;
  greeting: string;
  description: string;
  agentName: string;
  config: AgentConfig;
}

export const LIBRARY = library as unknown as TemplateEntry[];

export const findTemplate = (key: string) => LIBRARY.find((t) => t.key === key);

export const TIME_ZONES = [
  { value: "America/New_York", label: "Eastern time" },
  { value: "America/Chicago", label: "Central time" },
  { value: "America/Denver", label: "Mountain time" },
  { value: "America/Phoenix", label: "Arizona (no daylight saving)" },
  { value: "America/Los_Angeles", label: "Pacific time" },
  { value: "America/Anchorage", label: "Alaska time" },
  { value: "Pacific/Honolulu", label: "Hawaii time" },
] as const;

export const DEFAULT_TIME_ZONE = "America/Chicago";

export interface Customisation {
  businessName: string;
  description: string;
  timezone: string;
}

/** A copy of the template's config with this business's name, description and time zone. */
export function applyTemplate(config: AgentConfig, o: Customisation): AgentConfig {
  const c = structuredClone(config);
  c.persona.business_name = o.businessName.trim().slice(0, 200);
  c.persona.business_description = o.description.trim().slice(0, 1000);
  c.persona.timezone = o.timezone;
  return c;
}

/** The conditions that call for a live person, in plain words, for the template's detail page. */
export function handoffLines(config: AgentConfig): string[] {
  return config.escalation.filter((e) => e.action === "transfer").map((e) => e.condition);
}

/** The first few rules the agent will never break, for the detail page. */
export function neverLines(config: AgentConfig, n = 4): string[] {
  return config.guardrails.slice(0, n);
}
