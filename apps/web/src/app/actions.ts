"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { compileConfig, draftConfig, reviseConfig } from "@/lib/builder-api";
import { pushCard } from "@/lib/directory";
import { callToken } from "@/lib/livekit";
import type { Compiled, ValidationIssue } from "@/lib/config";
import { supabaseServer } from "@/lib/supabase/server";
import { TEMPLATES } from "@/lib/templates";

export type FormState = { error?: string; notice?: string; email?: string } | undefined;

const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

// --- auth -----------------------------------------------------------------------------

export async function signIn(_: FormState, form: FormData): Promise<FormState> {
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({
    email: text(form, "email"),
    password: String(form.get("password") ?? ""),
  });
  if (error) return { error: "That email and password don't match.", email: text(form, "email") };
  redirect("/");
}

export async function signUp(_: FormState, form: FormData): Promise<FormState> {
  // Sign-up is closed unless ALLOW_SIGNUP=true. The database also restricts who can create a
  // workspace (signup_allowlist), so this is a convenience layer, not the only lock.
  if (process.env.ALLOW_SIGNUP !== "true") {
    return { error: "Sign-up is by invitation. Ask Neato for an account." };
  }
  const password = String(form.get("password") ?? "");
  if (password.length < 8) {
    return { error: "Use at least 8 characters for the password.", email: text(form, "email") };
  }
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signUp({ email: text(form, "email"), password });
  if (error) {
    const limited = error.status === 429 || /rate limit/i.test(error.message);
    return {
      error: limited
        ? "Too many sign-up emails were sent. Wait about an hour and try again, or sign in if you already have an account."
        : "We couldn't create your account. Check the email address and try again.",
      email: text(form, "email"),
    };
  }
  // Supabase hides whether an email is registered: for an existing account it returns a
  // user with no identities, no session, and sends no new confirmation.
  if (data.user && data.user.identities?.length === 0) {
    return {
      error: "That email already has an account. Use Sign in instead.",
      email: text(form, "email"),
    };
  }
  if (!data.session) {
    return {
      notice: "Account created. Open the confirmation email, then come back here and sign in.",
      email: text(form, "email"),
    };
  }
  redirect("/");
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/login");
}

// --- accounts and agents --------------------------------------------------------------

export async function createAccount(_: FormState, form: FormData): Promise<FormState> {
  const name = text(form, "name");
  if (!name) return { error: "Enter a name for your workspace." };
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("create_account", { p_name: name });
  if (error) return { error: "We couldn't create the workspace. Try again." };
  redirect("/agents");
}

export async function createAgent(_: FormState, form: FormData): Promise<FormState> {
  const name = text(form, "name");
  const accountId = text(form, "account_id");
  if (!name) return { error: "Give the agent a name and choose how to start." };

  // Start from a template, or let AI draft the agent from a plain description.
  let config: unknown;
  let note: string;
  if (text(form, "mode") === "ai") {
    const description = text(form, "description");
    if (description.length < 30) {
      return { error: "Tell us a little more about the business: what it does, when it is open, and why people call." };
    }
    const drafted = await draftConfig(description);
    if (!drafted.ok) return { error: drafted.error };
    config = drafted.config;
    note = "Drafted by AI from your description";
  } else {
    const template = TEMPLATES.find((t) => t.key === text(form, "template"));
    if (!template) return { error: "Give the agent a name and choose how to start." };
    config = template.config;
    note = `Started from the ${template.label} template`;
  }

  const supabase = await supabaseServer();
  const { data: agent, error } = await supabase
    .from("agents")
    .insert({ account_id: accountId, name })
    .select("id")
    .single();
  if (error || !agent) return { error: "We couldn't create the agent. Try again." };

  const { error: vErr } = await supabase.rpc("save_agent_version", {
    p_agent: agent.id,
    p_config: config,
    p_note: note,
  });
  if (vErr) return { error: "The agent was created but its first version didn't save. Open it from the Agents page and save again." };
  after(() => pushCard(supabase, agent.id));
  redirect(`/agents/${agent.id}`);
}

/** Copy an agent's latest version into a new agent in the same workspace. */
export async function duplicateAgent(form: FormData): Promise<void> {
  const agentId = text(form, "agent_id");
  const supabase = await supabaseServer();
  const { data: source } = await supabase.from("agents").select("id, name, account_id").eq("id", agentId).maybeSingle();
  if (!source) redirect("/agents");
  const { data: latest } = await supabase
    .from("agent_versions")
    .select("version, config")
    .eq("agent_id", agentId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) redirect("/agents");

  const { data: copy } = await supabase
    .from("agents")
    .insert({ account_id: source.account_id, name: `${source.name} copy`.slice(0, 200) })
    .select("id")
    .single();
  if (!copy) redirect(`/agents/${agentId}`);
  await supabase.rpc("save_agent_version", {
    p_agent: copy.id,
    p_config: latest.config,
    p_note: `Copied from ${source.name}, version ${latest.version}`,
  });
  after(() => pushCard(supabase, copy.id));
  redirect(`/agents/${copy.id}?copied=1`);
}

export type AiResult =
  | { ok: true; config: unknown; summary: string }
  | { ok: false; error: string };

/** Ask AI to change an agent. Nothing is saved: the person reviews the changes first. */
export async function askAiToChange(config: unknown, instruction: string): Promise<AiResult> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) return { ok: false, error: "Your session ended. Sign in again to continue." };
  if (instruction.trim().length < 5) return { ok: false, error: "Describe what should change." };
  return reviseConfig(config, instruction.trim());
}

// --- editing --------------------------------------------------------------------------

export type PreviewResult =
  | { ok: true; compiled: Compiled }
  | { ok: false; errors: ValidationIssue[] }
  | { ok: false; unavailable: true };

/** Validate and compile a draft for the live preview. Signed-in users only. */
export async function previewConfig(config: unknown): Promise<PreviewResult> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) return { ok: false, errors: [{ path: "", message: "Your session ended. Sign in again to continue." }] };
  return compileConfig(config);
}

export type SaveResult =
  | { ok: true; version: number; id: string }
  | { ok: false; error: string; issues?: ValidationIssue[] };

export async function saveVersion(agentId: string, config: unknown, note: string): Promise<SaveResult> {
  const checked = await compileConfig(config);
  if (!checked.ok) {
    if ("errors" in checked) {
      return { ok: false, error: "Fix the problems listed in the preview, then save.", issues: checked.errors };
    }
    return { ok: false, error: "We couldn't check your changes, so nothing was saved. Try again in a minute." };
  }
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("save_agent_version", {
    p_agent: agentId,
    p_config: config,
    p_note: note.trim().slice(0, 500),
  });
  if (error || !data) {
    return { ok: false, error: "We couldn't save your changes. Try again in a moment. If it keeps happening, you may not have edit access." };
  }
  revalidatePath(`/agents/${agentId}`, "layout");
  const row = data as { version: number; id: string };
  return { ok: true, version: row.version, id: row.id };
}

export async function publishVersion(agentId: string, versionId: string): Promise<{ error?: string }> {
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("publish_agent_version", {
    p_agent: agentId,
    p_version: versionId,
  });
  if (error) return { error: "Couldn't publish. Try again, or ask the workspace owner." };
  after(() => pushCard(supabase, agentId));
  revalidatePath(`/agents/${agentId}`, "layout");
  return {};
}

// --- calls ----------------------------------------------------------------------------

export type CallResult =
  | { ok: true; url: string; token: string; room: string }
  | { ok: false; error: string };

/** Start a test call with a published agent from the browser. */
export async function startCall(agentId: string): Promise<CallResult> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return { ok: false, error: "Your session ended. Sign in again to start a test call." };

  // Row-level security means this only finds agents in the person's own workspaces.
  const { data: agent } = await supabase
    .from("agents")
    .select("id, published_version_id")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) return { ok: false, error: "That agent was not found." };
  if (!agent.published_version_id) {
    return { ok: false, error: "Publish this agent first. Test calls use the published version." };
  }
  try {
    return { ok: true, ...(await callToken({ agentId, userId })) };
  } catch {
    return { ok: false, error: "Test calls aren't available yet. Contact Neato." };
  }
}

export type SyncState = { message?: string; error?: string } | undefined;

/** Send every agent in the person's workspace to Votel's "Voice Agents" board. */
export async function syncAllToVotel(): Promise<SyncState> {
  const supabase = await supabaseServer();
  const { data: agents } = await supabase.from("agents").select("id");
  if (!agents?.length) return { message: "There are no agents to send yet." };
  let sent = 0;
  let firstError: string | undefined;
  for (const a of agents) {
    const r = await pushCard(supabase, a.id);
    if (r.ok) sent++;
    else firstError ??= r.error;
  }
  if (sent === 0) return { error: `We couldn't send your agents to Votel. ${firstError ?? ""}`.trim() };
  return {
    message: `Sent ${sent} agent${sent === 1 ? "" : "s"} to the Voice Agents board in Votel.` + (sent < agents.length ? ` ${agents.length - sent} didn't go through.` : ""),
  };
}
