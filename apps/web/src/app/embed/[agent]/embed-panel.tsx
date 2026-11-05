"use client";

import { Room, RoomEvent, Track, type Participant } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "connecting" | "live" | "ended";
interface Line { id: string; who: "you" | "agent"; text: string }

const AGENT_WAIT_MS = 25_000;
const STATE_LABEL: Record<string, string> = {
  listening: "Listening", thinking: "Thinking", speaking: "Speaking", initializing: "Getting ready",
};
const START_ERRORS: Record<string, string> = {
  busy: "This assistant has taken a lot of calls today. Please try again tomorrow.",
  slow_down: "You've started several calls in a row. Please wait a few minutes and try again.",
  not_ready: "This assistant isn't ready yet. Please try again later.",
};

export function EmbedPanel({ agentId, title }: { agentId: string; title: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [agentState, setAgentState] = useState("");
  const [muted, setMuted] = useState(false);
  const room = useRef<Room | null>(null);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioEls = useRef<HTMLMediaElement[]>([]);

  const cleanup = useCallback(() => {
    if (waitTimer.current) clearTimeout(waitTimer.current);
    audioEls.current.forEach((el) => el.remove());
    audioEls.current = [];
    room.current?.disconnect();
    room.current = null;
  }, []);
  useEffect(() => cleanup, [cleanup]);

  async function begin() {
    setError(null);
    setLines([]);
    setAgentState("");
    setMuted(false);
    setPhase("connecting");

    let creds: { url: string; token: string };
    try {
      const res = await fetch(`/api/embed/${agentId}/start`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url || !body.token) {
        setError(START_ERRORS[body.error as string] ?? "We couldn't start the call. Please try again in a minute.");
        setPhase("idle");
        return;
      }
      creds = body;
    } catch {
      setError("We couldn't start the call. Check your connection and try again.");
      setPhase("idle");
      return;
    }

    const r = new Room();
    room.current = r;
    r.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      document.body.appendChild(el);
      audioEls.current.push(el);
    });
    r.on(RoomEvent.ParticipantConnected, (p: Participant) => {
      if (p.isAgent && waitTimer.current) clearTimeout(waitTimer.current);
    });
    r.on(RoomEvent.ParticipantAttributesChanged, (changed, p) => {
      if (p.isAgent && changed["lk.agent.state"]) setAgentState(changed["lk.agent.state"]);
    });
    r.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
      const who = participant?.isLocal ? "you" : "agent";
      setLines((prev) => {
        const next = [...prev];
        for (const s of segments) {
          const i = next.findIndex((l) => l.id === s.id);
          const line: Line = { id: s.id, who, text: s.text };
          if (i >= 0) next[i] = line;
          else next.push(line);
        }
        return next.slice(-30);
      });
    });
    r.on(RoomEvent.Disconnected, () => {
      if (waitTimer.current) clearTimeout(waitTimer.current);
      setPhase((p) => (p === "idle" ? p : "ended"));
    });

    try {
      await r.connect(creds.url, creds.token);
      await r.startAudio();
      await r.localParticipant.setMicrophoneEnabled(true);
    } catch (e) {
      cleanup();
      const denied = e instanceof Error && /permission|denied|NotAllowed/i.test(e.message);
      setError(
        denied
          ? "Your browser blocked the microphone. Allow it for this site in your browser settings, then try again."
          : "We couldn't start the call. Please try again.",
      );
      setPhase("idle");
      return;
    }
    setPhase("live");
    waitTimer.current = setTimeout(() => {
      if (![...(r.remoteParticipants?.values() ?? [])].some((p) => p.isAgent)) {
        cleanup();
        setError("Nobody picked up. Please try again in a minute.");
        setPhase("idle");
      }
    }, AGENT_WAIT_MS);
  }

  function hangUp() {
    cleanup();
    setPhase("ended");
  }

  async function toggleMute() {
    const next = !muted;
    await room.current?.localParticipant.setMicrophoneEnabled(!next);
    setMuted(next);
  }

  const inCall = phase === "connecting" || phase === "live";
  return (
    <main className="flex min-h-dvh flex-col justify-center gap-4 p-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Talk to {title}</h1>
        <p className="mt-1 text-sm text-muted">
          You&apos;ll be speaking with an AI assistant. Allow your microphone when asked. Headphones help avoid echo.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {!inCall ? (
          <button className="btn btn-primary" onClick={begin}>
            {phase === "ended" ? "Call again" : "Start talking"}
          </button>
        ) : (
          <>
            <button className="btn btn-danger" onClick={hangUp} autoFocus>End call</button>
            <button className="btn" onClick={toggleMute} disabled={phase !== "live"} aria-pressed={muted}>
              Mute microphone
            </button>
          </>
        )}
        <span role="status" aria-live="polite" className="text-sm text-muted">
          {phase === "connecting" && "Connecting…"}
          {phase === "live" && (agentState ? (STATE_LABEL[agentState] ?? "") : "Connected. Waiting for the assistant…")}
          {phase === "ended" && "Call ended. Thanks for calling."}
        </span>
      </div>

      <p role="alert" className="text-sm text-danger empty:sr-only">{error ?? ""}</p>

      {lines.length > 0 && (
        <ul className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-line p-3" aria-label="Conversation so far">
          {lines.map((l) => (
            <li key={l.id} className="text-sm">
              <span className={`mr-2 font-medium ${l.who === "agent" ? "text-accent" : "text-muted"}`}>
                {l.who === "agent" ? "Assistant" : "You"}
              </span>
              {l.text}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-faint">
        This call is recorded and transcribed so the business can follow up. Don&apos;t share anything you wouldn&apos;t
        want saved.
      </p>
    </main>
  );
}
