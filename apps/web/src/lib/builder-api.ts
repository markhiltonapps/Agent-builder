import "server-only";
import type { Compiled, ValidationIssue } from "./config";
import { env } from "./env";

async function call(path: string, config: unknown) {
  const res = await fetch(`${env.builderApiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.builderApiSecret}` },
    body: JSON.stringify({ config }),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  return res;
}

export type CompileResult =
  | { ok: true; compiled: Compiled }
  | { ok: false; errors: ValidationIssue[] }
  | { ok: false; unavailable: true };

/** Validate and compile with the same Python code the worker runs. */
export async function compileConfig(config: unknown): Promise<CompileResult> {
  try {
    const res = await call("/v1/compile", config);
    if (res.status === 422) return { ok: false, errors: (await res.json()).errors };
    if (!res.ok) return { ok: false, unavailable: true };
    return { ok: true, compiled: await res.json() };
  } catch {
    return { ok: false, unavailable: true };
  }
}

export type DraftResult = { ok: true; config: unknown; summary: string } | { ok: false; error: string };

async function ai(path: string, body: unknown): Promise<DraftResult> {
  try {
    const res = await fetch(`${env.builderApiUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.builderApiSecret}` },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(150_000), // the model can take a minute
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) return { ok: true, config: data.config, summary: String(data.summary ?? "") };
    if (typeof data.error === "string") return { ok: false, error: data.error };
    if (Array.isArray(data.errors)) return { ok: false, error: "This agent has problems that need fixing before AI can change it." };
    return { ok: false, error: "AI help isn't available right now. Try again in a minute." };
  } catch {
    return { ok: false, error: "AI help took too long or couldn't be reached. Try again." };
  }
}

/** Draft a brand-new agent from a plain-language description. */
export const draftConfig = (description: string) => ai("/v1/draft", { description });

/** Propose an edit to an existing agent. Tools, connections and voice settings never change. */
export const reviseConfig = (config: unknown, instruction: string) => ai("/v1/revise", { config, instruction });
