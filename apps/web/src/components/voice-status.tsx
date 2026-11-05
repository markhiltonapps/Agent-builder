import { voiceStatus } from "@/lib/voice-status";

/** One line of readiness: is the voice service answering, and is the backup standing by? */
export async function VoiceStatusLine() {
  const s = await voiceStatus();
  const dot = (ok: boolean) => <span aria-hidden className={`inline-block size-2 rounded-full ${ok ? "bg-ok" : "bg-danger"}`} />;
  if (!s) {
    return <p className="text-xs text-faint">Voice status: we couldn&apos;t check just now.</p>;
  }
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-label="Voice service status">
      <span className="inline-flex items-center gap-1.5">{dot(s.primary.ok)} {s.primary.name}: {s.primary.ok ? "answering" : "not answering"}</span>
      {s.backup.configured ? (
        <span className="inline-flex items-center gap-1.5">{dot(s.backup.ok)} Backup, {s.backup.name}: {s.backup.ok ? "ready" : "not answering"}</span>
      ) : (
        <span className="text-faint">No backup voice set up yet</span>
      )}
      {s.failover && !s.primary.ok && s.backup.ok && <span className="font-medium text-text">Calls are using the backup.</span>}
    </p>
  );
}
