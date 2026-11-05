"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { compileConfig, draftConfig, reviseConfig } from "@/lib/builder-api";
import { pushCard } from "@/lib/directory";
import { MAX_SITES, parseSites } from "@/lib/embed-code";
import { forgetEmbedInfo } from "@/lib/embed-info";
import { logoKind, logoProblem } from "@/lib/embed-logo";
import { importVotelAgent, listVotelBookables, type VotelBookable } from "@/lib/votel-import";
import { getVotelClient, listVotelClients, pushVotelClient, type VotelClient } from "@/lib/votel-clients";
import { callToken } from "@/lib/livekit";
import type { Compiled, ValidationIssue } from "@/lib/config";
import { supabaseServer } from "@/lib/supabase/server";
import { DEFAULT_TIME_ZONE, TIME_ZONES, applyTemplate, findTemplate } from "@/lib/template-library";

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
  if (!name) return { error: "Give the agent a name first." };

  // Let AI draft the agent from a plain description of the business.
  const description = text(form, "description");
  if (description.length < 30) {
    return { error: "Tell us a little more about the business: what it does, when it is open, and why people call." };
  }
  const drafted = await draftConfig(description);
  if (!drafted.ok) return { error: drafted.error };
  return saveNewAgent(accountId, name, drafted.config, "Drafted by AI from your description");
}

/** Start an agent from a ready-made template, customised with the business's own details. */
export async function createAgentFromTemplate(_: FormState, form: FormData): Promise<FormState> {
  const entry = findTemplate(text(form, "template"));
  const name = text(form, "name");
  const businessName = text(form, "business_name");
  if (!entry) return { error: "That template wasn't found. Go back and pick one again." };
  if (!name) return { error: "Give the agent a name, like “Front desk”." };
  if (!businessName) return { error: "Enter your business name. The agent says it when it answers." };
  const timezone = TIME_ZONES.some((z) => z.value === text(form, "timezone")) ? text(form, "timezone") : DEFAULT_TIME_ZONE;
  const config = applyTemplate(entry.config, { businessName, description: text(form, "description") || entry.description, timezone });

  const checked = await compileConfig(config);
  if (!checked.ok) {
    return { error: "errors" in checked ? "Something in those details didn't fit. Shorten the business name or description and try again." : "We couldn't check the agent just now. Try again in a minute." };
  }
  return saveNewAgent(text(form, "account_id"), name, config, `Started from the ${entry.label} template`);
}

/** Make a new agent out of one that was built in Votel. It starts as a draft for the person to review. */
export async function createAgentFromVotel(_: FormState, form: FormData): Promise<FormState> {
  const votelId = text(form, "votel_agent");
  if (!votelId) return { error: "Choose the Votel agent to bring over." };
  const imported = await importVotelAgent(votelId);
  if (!imported.ok) return { error: imported.error };
  const name = text(form, "name") || imported.name;
  return saveNewAgent(text(form, "account_id"), name, imported.config, `Imported from the Votel agent “${imported.name}”`);
}

async function saveNewAgent(accountId: string, name: string, config: unknown, note: string): Promise<FormState> {
  const supabase = await supabaseServer();
  const { data: agent, error } = await supabase
    .from("agents")
    .insert({ account_id: accountId, name: name.slice(0, 200) })
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

/** Send every agent in the person's workspace to Votel's "Agent Builder OS" board. */
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
    message: `Sent ${sent} agent${sent === 1 ? "" : "s"} to the Agent Builder OS board in Votel.` + (sent < agents.length ? ` ${agents.length - sent} didn't go through.` : ""),
  };
}

// --- website embed ---------------------------------------------------------------------

export type EmbedSaveResult = { ok: true; sites: string[] } | { ok: false; error: string };

/** Turn the website embed on or off for an agent, and say which sites may show it. */
export async function saveEmbed(agentId: string, enabled: boolean, sitesText: string, dailyLimit: number): Promise<EmbedSaveResult> {
  const { sites, bad } = parseSites(sitesText);
  if (bad.length) {
    return { ok: false, error: `These don't look like website addresses: ${bad.slice(0, 3).join(", ")}. Use something like example.com.` };
  }
  if (sites.length > MAX_SITES) return { ok: false, error: `Use at most ${MAX_SITES} websites.` };
  const limit = Math.round(Number(dailyLimit));
  if (!(limit >= 1 && limit <= 2000)) return { ok: false, error: "Choose a daily limit between 1 and 2000 calls." };

  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("set_embed_settings", {
    p_agent: agentId,
    p_enabled: enabled,
    p_origins: sites,
    p_limit: limit,
  });
  if (error) return { ok: false, error: "We couldn't save that. You may not have edit access to this agent." };
  forgetEmbedInfo(agentId);
  revalidatePath(`/agents/${agentId}/embed`);
  return { ok: true, sites };
}

export type LogoResult = { ok: true; url: string } | { ok: false; error: string };

/** Store a logo for the website button and give back its public address. */
export async function uploadEmbedLogo(agentId: string, form: FormData): Promise<LogoResult> {
  const file = form.get("logo");
  if (!(file instanceof File)) return { ok: false, error: "Choose a picture first." };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const problem = logoProblem(bytes);
  const kind = logoKind(bytes);
  if (problem || !kind) return { ok: false, error: problem ?? "Use a PNG, JPG or WebP picture." };
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return { ok: false, error: "We couldn't find that agent." };

  const supabase = await supabaseServer();
  const path = `${agentId}/${crypto.randomUUID()}.${kind.ext}`;
  const { error } = await supabase.storage.from("embed-logos").upload(path, bytes, { contentType: kind.type, cacheControl: "31536000" });
  if (error) return { ok: false, error: "We couldn't save that picture. You may not have edit access to this agent." };
  return { ok: true, url: supabase.storage.from("embed-logos").getPublicUrl(path).data.publicUrl };
}

// --- clients (workspaces) ----------------------------------------------------------------

const rememberClient = async (id: string) =>
  (await cookies()).set("client", id, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: true });

/** Work in another client. Only a workspace the person belongs to is accepted. */
export async function switchClient(accountId: string): Promise<void> {
  const supabase = await supabaseServer();
  const { data } = await supabase.from("accounts").select("id").eq("id", accountId).maybeSingle();
  if (data) await rememberClient(data.id);
  revalidatePath("/", "layout");
}

export async function openClient(form: FormData): Promise<void> {
  await switchClient(text(form, "account_id"));
  redirect("/dashboard");
}

/** Add a client: a new workspace the person owns, which becomes the one they are working in. */
export async function addClient(_: FormState, form: FormData): Promise<FormState> {
  const name = text(form, "name");
  if (!name) return { error: "Enter the client's name." };
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("create_account", { p_name: name.slice(0, 200) });
  if (error || !data) return { error: "We couldn't add the client. Try again." };
  const id = (data as { id: string }).id;
  // Also make (or find) the client's contact in Votel, tagged agent-builder-client. Best effort:
  // if Votel can't be reached the client is still added, and "Send to Votel" can be used later.
  if (form.get("to_votel")) {
    const pushed = await pushVotelClient({ name, email: text(form, "email"), phone: text(form, "phone") });
    if (pushed.ok) await supabase.rpc("link_client_votel", { p_account: id, p_contact: pushed.contactId });
  }
  await rememberClient(id);
  redirect("/clients");
}

export type VotelClientsResult = { ok: true; clients: VotelClient[]; tag: string } | { ok: false; error: string };

/** The Votel contacts tagged as clients that aren't clients here yet. */
export async function loadVotelClients(): Promise<VotelClientsResult> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) return { ok: false, error: "Your session ended. Sign in again to continue." };
  const found = await listVotelClients();
  if (!found.ok) return found;
  const { data: linked } = await supabase.from("accounts").select("votel_contact_id").not("votel_contact_id", "is", null);
  const taken = new Set((linked ?? []).map((a) => String(a.votel_contact_id).toLowerCase()));
  return { ok: true, tag: found.tag, clients: found.clients.filter((c) => !taken.has(c.id.toLowerCase())) };
}

export type ClientLinkResult = { ok: true; name: string } | { ok: false; error: string };

/** Make a Votel contact (one with the client tag) a client here, with a workspace of its own. */
export async function addClientFromVotel(contactId: string): Promise<ClientLinkResult> {
  const supabase = await supabaseServer();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) return { ok: false, error: "Your session ended. Sign in again to continue." };
  const got = await getVotelClient(contactId);
  if (!got.ok) return got;
  const { data: dup } = await supabase.from("accounts").select("id").eq("votel_contact_id", got.client.id).maybeSingle();
  if (dup) return { ok: false, error: `${got.client.name} is already a client here.` };
  const { data, error } = await supabase.rpc("create_account", { p_name: got.client.name.slice(0, 200) });
  if (error || !data) return { ok: false, error: "We couldn't add the client. Try again." };
  const id = (data as { id: string }).id;
  const { error: linkError } = await supabase.rpc("link_client_votel", { p_account: id, p_contact: got.client.id });
  if (linkError) return { ok: false, error: "The client was added but couldn't be linked to Votel. Use Send to Votel on its card." };
  revalidatePath("/clients");
  return { ok: true, name: got.client.name };
}

/** Create (or find) this client's contact in Votel, tag it, and remember the link. */
export async function sendClientToVotel(accountId: string): Promise<ClientLinkResult> {
  const supabase = await supabaseServer();
  const { data: account } = await supabase.from("accounts").select("name, votel_contact_id").eq("id", accountId).maybeSingle();
  if (!account) return { ok: false, error: "We couldn't find that client." };
  const pushed = await pushVotelClient({ name: account.name, contactId: account.votel_contact_id });
  if (!pushed.ok) return pushed;
  const { error } = await supabase.rpc("link_client_votel", { p_account: accountId, p_contact: pushed.contactId });
  if (error) {
    return { ok: false, error: error.code === "23505" ? "That Votel contact is already linked to another client." : "Only the owner of a client can link it to Votel." };
  }
  revalidatePath("/clients");
  return { ok: true, name: account.name };
}

/** Stop linking this client to its Votel contact. The contact itself is left alone in Votel. */
export async function unlinkClientFromVotel(accountId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("link_client_votel", { p_account: accountId, p_contact: null });
  if (error) return { ok: false, error: "Only the owner of a client can change this." };
  revalidatePath("/clients");
  return { ok: true };
}

export type ShareResult = { ok: true; token: string | null } | { ok: false; error: string };

/** Switch a client's read-only dashboard link on or off, or replace it with a new one. */
export async function setClientShare(accountId: string, enabled: boolean, rotate = false): Promise<ShareResult> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("set_client_share", { p_account: accountId, p_enabled: enabled, p_rotate: rotate });
  if (error) return { ok: false, error: "Only the owner of a client can change its dashboard link." };
  revalidatePath("/clients");
  return { ok: true, token: (data as string | null) ?? null };
}

/** The Votel booking services an agent's appointment requests can go to. Signed-in people only. */
export async function loadBookables(): Promise<{ ok: true; bookables: VotelBookable[] } | { ok: false; error: string }> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) return { ok: false, error: "Your session ended. Sign in again to continue." };
  return listVotelBookables();
}
