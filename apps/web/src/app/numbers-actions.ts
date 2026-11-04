"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import * as numbers from "@/lib/phone-numbers";

export type SearchState = { results?: numbers.AvailableNumber[]; error?: string; area?: string } | undefined;
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
  if (!(await owner())) return { error: OWNER_ONLY };
  const area = String(form.get("area") ?? "").replace(/\D/g, "");
  if (area.length !== 3) return { error: "Enter a 3-digit area code, like 602.", area };
  try {
    const results = await numbers.search(area);
    return results.length
      ? { results, area }
      : { error: `No numbers are available in ${area} right now. Try a nearby area code.`, area };
  } catch (e) {
    return { error: FAIL(e), area };
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
