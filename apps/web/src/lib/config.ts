// Mirror of apps/agent/src/agent_builder/config.py. The Python models are the source of truth:
// the server validates every save through the builder API, so these types only guide the UI.

export type Tone = "warm" | "professional" | "upbeat" | "calm";
export type EscalationAction = "transfer" | "take_message" | "end_call";

export interface ParameterSpec {
  type: "string" | "integer" | "number" | "boolean";
  description: string;
  enum?: string[] | null;
  required?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ParameterSpec>;
  adapter: string;
  goal: boolean;
}

export interface AdapterConfig {
  kind: "mock" | "http" | "disabled";
  options: Record<string, unknown>;
}

export interface ModelSpec {
  provider: "openai" | "azure";
  model: string;
  voice: string;
  backend_model?: string | null;
  azure_deployment?: string | null;
  azure_backend_deployment?: string | null;
}

export interface AgentConfig {
  schema_version: 1;
  persona: {
    agent_name: string;
    business_name: string;
    business_description: string;
    tone: Tone;
    languages: string[];
    bot_disclosure: string;
    timezone: string;
  };
  greetings: { opening: string; still_there: string; goodbye: string };
  guardrails: string[];
  escalation: { condition: string; action: EscalationAction; handoff_summary: string }[];
  policy: {
    speaking_rules: string;
    backend_flows: string;
    interruption: "yield_immediately" | "finish_sentence";
    backchannel: "none" | "light" | "natural";
  };
  tools: ToolDefinition[];
  adapters: Record<string, AdapterConfig>;
  booking?: { url: string; channel: "sms" | "email" } | null;
  calendar?: { service_id: string; service_name: string; duration_minutes: number } | null;
  runtime: {
    voice: ModelSpec;
    fallbacks: ModelSpec[];
    max_call_seconds: number;
    silence_timeout_seconds: number;
  };
}

/**
 * An agent as stored may leave out parts that have defaults (the builder fills them in when it
 * reads the config). The editor needs them present, so fill them in the same way.
 */
export function withDefaults(stored: Partial<AgentConfig>): AgentConfig {
  const c = stored as AgentConfig;
  return {
    ...c,
    guardrails: c.guardrails ?? [],
    escalation: c.escalation ?? [],
    policy: { speaking_rules: "", backend_flows: "", interruption: "yield_immediately", backchannel: "light", ...(c.policy as Partial<AgentConfig["policy"]> | undefined) },
    tools: c.tools ?? [],
    adapters: c.adapters ?? {},
    runtime: {
      fallbacks: [],
      max_call_seconds: 900,
      silence_timeout_seconds: 15,
      ...(c.runtime as Partial<AgentConfig["runtime"]> | undefined),
      voice: { provider: "openai", model: "gpt-live-1", voice: "marin", ...(c.runtime?.voice as Partial<ModelSpec> | undefined) },
    },
  };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface Compiled {
  voice_instructions: string;
  backend_instructions: string;
  opening_line: string;
  still_there_line: string;
  goodbye_line: string;
  tools: { name: string; description: string; schema: unknown }[];
  fingerprint: string;
}
