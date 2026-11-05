"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import * as numbers from "@/lib/phone-numbers";
import { parseAreaCodes, type Where } from "@/lib/number-match";

export type SearchState = { results?: numbers.AvailableNumber[]; error?: string; area?: string; digits?: string; where?: Where } | undefined;
export type Done = { ok: true; message: string } | { ok: false; error: string };

/** Renting and releasing numbers costs real money, so only a workspace owner may do it. */
async function owner() {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return null;
  const { data: rows } = await supabase.from("account_members").select("account_id").eq("user_id", userId).eq("role", "owner");
  return rows?.length ? { supabase, accounts: rows.map((r) => r.account_id as string) } : null;
}

const OWNER_ONLY = "Only a workspace owner can manage phone numbers.";
const FAIL = (e: unknown) =>
  e instanceof numbers.NumberError ? e.message : "Something went wrong talking to the phone service. Try again.";

export async function searchNumbers(_: SearchState, form: FormData): Promise<SearchState> {
  const area = String(form.get("area") ?? "");
  const digits = String(form.get("digits") ?? "").replace(/\D/g, "").slice(0, 7);
  const where: Where = form.get("where") === "start" ? "start" : form.get("where") === "end" ? "end" : "anywhere";
  const echo = { area, digits, where };
  if (!(await owner())) return { error: OWNER_ONLY, ...echo };
  const { codes, bad } = parseAreaCodes(area);
  if (bad.length || codes.length === 0) {
    return { error: "Enter a 3-digit area code, like 602. You can add up to three, like 602, 480.", ...echo };
  }
  try {
    const { numbers: found, looked } = await numbers.search(codes, digits, where);
    if (found.length) return { results: found, ...echo };
    const where_ = where === "start" ? "starting with" : where === "end" ? "ending in" : "containing";
    return {
      error: digits
        ? `None of the ${looked} numbers available in ${codes.join(", ")} right now are ${where_} ${digits}. Try fewer digits, another place in the number, or another area code.`
        : `No numbers are available in ${codes.join(", ")} right now. Try a nearby area code.`,
      ...echo,
    };
  } catch (e) {
    return { error: FAIL(e), ...echo };
  }
}

async function publishedAgent(agentId: string) {
  const o = await owner();
  if (!o) return null;
  const { data } = await o.supabase.from("agents").select("id, name, account_id, published_version_id").eq("id", agentId).maybeSingle();
  return data?.published_version_id && o.accounts.includes(data.account_id) ? data : null;
}

export async function rentNumber(e164: string, agentId: string): Promise<Done> {
  if (!(await owner())) return { ok: false, error: OWNER_ONLY };
  if (!/^\+1\d{10}$/.test(e164)) return { ok: false, error: "That doesn't look like a US phone number." };
  const agent = await publishedAgent(agentId);
  if (!agent) return { ok: false, error: "Choose an agent that is published. Callers reach the published version." };
  try {
    const have = await numbers.owned();
    if (have.length >= numbers.MAX_NUMBERS) {
      return { ok: false, error: `You already have ${have.length} numbers. Release one before renting another.` };
    }
    const before = (await numbers.owned()).map((n) => n.ruleId);
    const ruleId = await numbers.ruleFor(agent.id, agent.name);
    await numbers.rent(e164, ruleId, !before.includes(ruleId));
    revalidatePath("/numbers");
    return { ok: true, message: `${numbers.formatNumber(e164)} is yours. Calls to it are answered by ${agent.name}.` };
  } catch (e) {
    return { ok: false, error: FAIL(e) };
  }
}

export async function changeNumberAgent(e164: string, agentId: string): Promise<Done> {
  const agent = await publishedAgent(agentId);
  if (!agent) return { ok: false, error: "Choose an agent that is published." };
  try {
    const current = (await numbers.owned()).find((n) => n.e164 === e164);
    if (!current) return { ok: false, error: "That number isn't in your project." };
    const ruleId = await numbers.ruleFor(agent.id, agent.name);
    await numbers.reassign(e164, ruleId);
    if (current.ruleId && current.ruleId !== ruleId) await numbers.removeRuleIfUnused(current.ruleId);
    revalidatePath("/numbers");
    return { ok: true, message: `${numbers.formatNumber(e164)} now rings ${agent.name}.` };
  } catch (e) {
    return { ok: false, error: FAIL(e) };
  }
}

export async function releaseNumber(e164: string): Promise<Done> {
  if (!(await owner())) return { ok: false, error: OWNER_ONLY };
  try {
    const current = (await numbers.owned()).find((n) => n.e164 === e164);
    await numbers.release(e164);
    if (current?.ruleId) await numbers.removeRuleIfUnused(current.ruleId);
    revalidatePath("/numbers");
    return { ok: true, message: `${numbers.formatNumber(e164)} was released. You won't be charged for it again.` };
  } catch (e) {
    return { ok: false, error: FAIL(e) };
  }
}
