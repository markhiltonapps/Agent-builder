import homeServices from "./templates/home_services.json";
import type { AgentConfig } from "./config";

// Synced from apps/agent/templates by `npm run sync-templates` (runs before dev and build).
export const TEMPLATES: { key: string; label: string; blurb: string; config: AgentConfig }[] = [
  {
    key: "home_services",
    label: "Home services receptionist",
    blurb: "Quotes, bookings and callbacks for plumbing, HVAC and electrical.",
    config: homeServices as unknown as AgentConfig,
  },
];
