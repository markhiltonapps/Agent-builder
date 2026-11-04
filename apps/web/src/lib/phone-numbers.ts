import "server-only";
import { AccessToken, RoomAgentDispatch, RoomConfiguration, SipClient } from "livekit-server-sdk";
import { WORKER_NAME } from "./livekit";

// LiveKit Phone Numbers: search, rent, assign and release US numbers for inbound calls.
// https://docs.livekit.io/reference/telephony/phone-numbers-api/

const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v;
};
const host = () => need("LIVEKIT_URL").replace(/^wss?:/, "https:").replace(/\/$/, "");

export class NumberError extends Error {}

async function twirp<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const at = new AccessToken(need("LIVEKIT_API_KEY"), need("LIVEKIT_API_SECRET"), { ttl: "5m" });
  at.addSIPGrant({ admin: true });
  const res = await fetch(`${host()}/twirp/livekit.PhoneNumberService/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await at.toJwt()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new NumberError(typeof data.msg === "string" ? data.msg : `LiveKit said ${res.status}`);
  return data as T;
}

const sip = () => new SipClient(host(), need("LIVEKIT_API_KEY"), need("LIVEKIT_API_SECRET"));

export interface AvailableNumber { e164: string; area: string; place: string }
export interface OwnedNumber { id: string; e164: string; status: string; ruleId: string | null; agentId: string | null }

interface RawNumber {
  id?: string; e164_format: string; area_code?: string; locality?: string; region?: string;
  status?: string; sip_dispatch_rule_ids?: string[]; sip_dispatch_rule_id?: string;
}

export const MAX_NUMBERS = Number(process.env.MAX_PHONE_NUMBERS ?? 3);

export async function search(areaCode: string): Promise<AvailableNumber[]> {
  const data = await twirp<{ items?: RawNumber[] }>("SearchPhoneNumbers", { country_code: "US", area_code: areaCode, limit: 10 });
  return (data.items ?? []).map((n) => ({
    e164: n.e164_format, area: n.area_code ?? areaCode,
    place: [titleCase(n.locality), n.region].filter(Boolean).join(", "),
  }));
}

const titleCase = (s?: string) => (s ?? "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** The agent a dispatch rule sends calls to, read from the rule's own dispatch metadata. */
function agentOf(rule: { roomConfig?: { agents?: { metadata?: string }[] } }): string | null {
  try {
    return JSON.parse(rule.roomConfig?.agents?.[0]?.metadata ?? "{}").agent_id ?? null;
  } catch {
    return null;
  }
}

export async function owned(): Promise<OwnedNumber[]> {
  const [data, rules] = await Promise.all([
    twirp<{ items?: RawNumber[] }>("ListPhoneNumbers", { limit: 50 }),
    sip().listSipDispatchRule(),
  ]);
  const byId = new Map(rules.map((r) => [r.sipDispatchRuleId, r]));
  return (data.items ?? [])
    .filter((n) => !/RELEASED/.test(n.status ?? ""))
    .map((n) => {
      const ruleId = n.sip_dispatch_rule_ids?.[0] || n.sip_dispatch_rule_id || null;
      const rule = ruleId ? byId.get(ruleId) : undefined;
      return {
        id: n.id ?? "", e164: n.e164_format,
        status: (n.status ?? "").replace("PHONE_NUMBER_STATUS_", "").toLowerCase(),
        ruleId, agentId: rule ? agentOf(rule) : null,
      };
    });
}

/** One dispatch rule per agent: inbound calls become rooms that the named worker joins. */
export async function ruleFor(agentId: string, agentName: string): Promise<string> {
  const name = `neato:${agentId}`;
  const existing = (await sip().listSipDispatchRule()).find((r) => r.name === name);
  if (existing) return existing.sipDispatchRuleId;
  const rule = await sip().createSipDispatchRule(
    { type: "individual", roomPrefix: "call-" },
    {
      name,
      metadata: JSON.stringify({ agent_id: agentId, agent_name: agentName }),
      roomConfig: new RoomConfiguration({
        agents: [new RoomAgentDispatch({ agentName: WORKER_NAME, metadata: JSON.stringify({ agent_id: agentId }) })],
      }),
    },
  );
  return rule.sipDispatchRuleId;
}

/** Rent a number and point it at an agent. Costs money. Cleans up the rule if renting fails. */
export async function rent(e164: string, ruleId: string, createdRule: boolean): Promise<void> {
  try {
    await twirp("PurchasePhoneNumber", { phone_numbers: [e164], sip_dispatch_rule_id: ruleId });
  } catch (e) {
    if (createdRule) await sip().deleteSipDispatchRule(ruleId).catch(() => undefined);
    throw e;
  }
}

export const reassign = (e164: string, ruleId: string) =>
  twirp("UpdatePhoneNumber", { phone_number: e164, sip_dispatch_rule_id: ruleId });

export async function release(e164: string): Promise<void> {
  await twirp("ReleasePhoneNumbers", { phone_numbers: [e164] });
}

export async function removeRuleIfUnused(ruleId: string): Promise<void> {
  const still = (await owned()).some((n) => n.ruleId === ruleId);
  if (!still) await sip().deleteSipDispatchRule(ruleId).catch(() => undefined);
}

export { formatNumber } from "./phone-format";
