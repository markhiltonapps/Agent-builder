import "server-only";
import { env } from "./env";

export interface ProviderStatus { name: string; ok: boolean; configured?: boolean; ms?: number; status?: number | string }
export interface VoiceStatus { primary: ProviderStatus; backup: ProviderStatus; failover: boolean }

/** Whether the voice providers answer right now, or null if we couldn't ask. */
export async function voiceStatus(): Promise<VoiceStatus | null> {
  try {
    const res = await fetch(`${env.builderApiUrl}/v1/voice/status`, {
      headers: { Authorization: `Bearer ${env.builderApiSecret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(9_000),
    });
    return res.ok ? ((await res.json()) as VoiceStatus) : null;
  } catch {
    return null;
  }
}
