// Plain-language names for config paths, so people see "About the business", not
// "persona.business_description". Used by error lists and change lists.

const LABELS: Record<string, string> = {
  "persona.agent_name": "Agent name",
  "persona.business_name": "Business name",
  "persona.business_description": "About the business",
  "persona.tone": "Tone",
  "persona.languages": "Languages",
  "persona.bot_disclosure": "If asked “are you a person?”",
  "persona.timezone": "Time zone",
  "greetings.opening": "Opening line",
  "greetings.still_there": "When the caller goes quiet",
  "greetings.goodbye": "Goodbye",
  "guardrails": "Rules",
  "escalation": "Handoffs",
  "policy.speaking_rules": "Extra speaking rules",
  "policy.backend_flows": "Step-by-step flows",
  "policy.interruption": "When the caller interrupts",
  "policy.backchannel": "Listening sounds",
  "tools": "Actions",
  "adapters": "Connections",
  "runtime.voice.voice": "Voice",
  "runtime.voice.model": "Voice model",
  "runtime.max_call_seconds": "Longest call",
  "runtime.silence_timeout_seconds": "Quiet time before checking in",
};

const SINGULAR: Record<string, string> = { Rules: "Rule", Handoffs: "Handoff", Actions: "Action" };

const SEGMENT: Record<string, string> = {
  condition: "when",
  action: "then",
  handoff_summary: "note for whoever takes over",
  description: "what it does",
};

/** "escalation[1].condition" or "escalation.1.condition" -> "Handoffs, rule 2: when". */
export function labelFor(path: string): string {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  if (parts.length === 0) return "Settings";
  for (let n = parts.length; n > 0; n--) {
    const hit = LABELS[parts.slice(0, n).join(".")];
    if (hit) {
      const rest = parts.slice(n);
      if (rest.length === 0) return hit;
      const [first, ...tail] = rest;
      const numbered = /^\d+$/.test(first);
      const field = (numbered ? tail : rest).map((s) => SEGMENT[s] ?? s.replace(/_/g, " ")).join(" ");
      const head = numbered ? `${SINGULAR[hit] ?? "Item"} ${Number(first) + 1}` : hit;
      return `${head}${field ? `: ${field}` : ""}`;
    }
  }
  return parts.map((s) => s.replace(/_/g, " ")).join(" › ");
}

/** "check_service_area" -> "Check service area". */
export function friendlyName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
