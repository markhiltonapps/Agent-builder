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
