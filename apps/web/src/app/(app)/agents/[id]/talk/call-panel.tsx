"use client";

import { Room, RoomEvent, Track, type Participant } from "livekit-client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { startCall } from "@/app/actions";

type Phase = "idle" | "connecting" | "live" | "ended";
interface Line { id: string; who: "you" | "agent"; text: string; final: boolean }

const AGENT_WAIT_MS = 25_000;

export function CallPanel({
  agentId, agentName, liveVersion,
}: { agentId: string; agentName: string; liveVersion: number | null }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [agentState, setAgentState] = useState<string>("");
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

    const res = await startCall(agentId);
    if (!res.ok) {
      setError(res.error);
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
          const line = { id: s.id, who, text: s.text, final: s.final } as Line;
          if (i >= 0) next[i] = line;
          else next.push(line);
        }
        return next;
      });
    });
    r.on(RoomEvent.Disconnected, () => {
      if (waitTimer.current) clearTimeout(waitTimer.current);
      setPhase((p) => (p === "idle" ? p : "ended"));
    });

    try {
      await r.connect(res.url, res.token);
      await r.startAudio();
      await r.localParticipant.setMicrophoneEnabled(true);
    } catch (e) {
      cleanup();
      const denied = e instanceof Error && /permission|denied|NotAllowed/i.test(e.message);
      setError(
        denied
          ? "The browser blocked the microphone. Allow it for this site, then try again."
          : "Could not connect the call. Please try again.",
      );
      setPhase("idle");
      return;
    }
    setPhase("live");
    // If the voice worker is not running, nobody answers. Say so instead of sitting silent.
    waitTimer.current = setTimeout(() => {
      if (![...(r.remoteParticipants?.values() ?? [])].some((p) => p.isAgent)) {
        cleanup();
        setError("The voice agent did not answer. The voice worker may be offline.");
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

  if (liveVersion === null) {
    return (
      <div className="glass p-6">
        <p className="mb-3">Calls run the <strong>published</strong> version, and this agent has none yet.</p>
        <Link href={`/agents/${agentId}`} className="btn btn-primary">Go publish it</Link>
      </div>
    );
  }

  const inCall = phase === "connecting" || phase === "live";
  return (
    <div className="glass space-y-5 p-6">
      <p className="text-sm text-muted">
        You&apos;ll talk to <strong className="font-medium text-text">{agentName}</strong> as it is live now
        (version {liveVersion}). Allow the microphone when your browser asks. Use headphones to avoid echo.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        {!inCall ? (
          <button className="btn btn-primary" onClick={begin}>
            {phase === "ended" ? "Call again" : "Start call"}
          </button>
        ) : (
          <>
            <button className="btn btn-danger" onClick={hangUp}>End call</button>
            <button className="btn" onClick={toggleMute} disabled={phase !== "live"} aria-pressed={muted}>
              {muted ? "Unmute" : "Mute"}
            </button>
          </>
        )}
        <span role="status" aria-live="polite" className="text-sm text-muted">
          {phase === "connecting" && "Connecting…"}
          {phase === "live" && (agentState ? `Agent: ${agentState}` : "Connected. Waiting for the agent…")}
          {phase === "ended" && "Call ended."}
        </span>
      </div>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      {lines.length > 0 && (
        <ul className="max-h-96 space-y-2 overflow-y-auto rounded-lg border border-line p-4" aria-label="Transcript">
          {lines.map((l) => (
            <li key={l.id} className={`text-sm ${l.final ? "" : "opacity-70"}`}>
              <span className={`mr-2 font-medium ${l.who === "agent" ? "text-accent" : "text-muted"}`}>
                {l.who === "agent" ? agentName : "You"}
              </span>
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
