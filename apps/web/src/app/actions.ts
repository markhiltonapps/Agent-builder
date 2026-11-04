"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { compileConfig } from "@/lib/builder-api";
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
  if (error) return { error: error.message, email: text(form, "email") };
  if (!data.session) return { notice: "Check your email to confirm the account, then sign in." };
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
  if (!name) return { error: "Give the workspace a name." };
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("create_account", { p_name: name });
  if (error) return { error: "Could not create the workspace." };
  redirect("/agents");
}

export async function createAgent(_: FormState, form: FormData): Promise<FormState> {
  const name = text(form, "name");
  const accountId = text(form, "account_id");
  const template = TEMPLATES.find((t) => t.key === text(form, "template"));
  if (!name || !template) return { error: "Name the agent and pick a template." };

  const supabase = await supabaseServer();
  const { data: agent, error } = await supabase
    .from("agents")
    .insert({ account_id: accountId, name })
    .select("id")
    .single();
  if (error || !agent) return { error: "Could not create the agent." };

  const { error: vErr } = await supabase.rpc("save_agent_version", {
    p_agent: agent.id,
    p_config: template.config,
    p_note: `Started from the ${template.label} template`,
  });
  if (vErr) return { error: "The agent was created but its first version failed to save." };
  redirect(`/agents/${agent.id}`);
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
  if (!data?.claims) return { ok: false, errors: [{ path: "", message: "Sign in again." }] };
  return compileConfig(config);
}

export type SaveResult =
  | { ok: true; version: number; id: string }
  | { ok: false; error: string; issues?: ValidationIssue[] };

export async function saveVersion(agentId: string, config: unknown, note: string): Promise<SaveResult> {
  const checked = await compileConfig(config);
  if (!checked.ok) {
    if ("errors" in checked) {
      return { ok: false, error: "Fix the highlighted problems first.", issues: checked.errors };
    }
    return { ok: false, error: "The validation service is unreachable, so nothing was saved." };
  }
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("save_agent_version", {
    p_agent: agentId,
    p_config: config,
    p_note: note.trim().slice(0, 500),
  });
  if (error || !data) {
    return { ok: false, error: "You don't have permission to save changes to this agent." };
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
  if (error) return { error: "Could not publish. You may not have permission." };
  revalidatePath(`/agents/${agentId}`, "layout");
  return {};
}
