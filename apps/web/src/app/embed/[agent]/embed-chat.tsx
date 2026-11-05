"use client";

import { useEffect, useRef, useState } from "react";
import { useStickyScroll } from "@/lib/use-sticky-scroll";

interface Message { id: number; who: "you" | "agent"; text: string }
type Phase = "idle" | "starting" | "open" | "ended";

const MAX = 1000;
const START_ERRORS: Record<string, string> = {
  limit: "This assistant has taken a lot of chats today. Please try again tomorrow.",
  busy: "The assistant is busy right now. Please try again in a few minutes.",
  slow_down: "You've started several chats in a row. Please wait a few minutes and try again.",
  unpublished: "This assistant isn't ready yet. Please try again later.",
};
const SEND_ERRORS: Record<string, string> = {
  gone: "This chat has ended. Start a new one to keep going.",
  too_long: "That message is too long. Please shorten it.",
  limit: "This chat has gotten long. Please start a new one.",
  slow_down: "Slow down a little, then send that again.",
};

/** A typed conversation with the agent. Nothing starts (or counts) until the visitor chooses to. */
export function ChatPanel({ agentId }: { agentId: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = useRef(1);
  const input = useRef<HTMLTextAreaElement>(null);
  const live = useRef<string | null>(null);
  const { ref: logRef, onScroll } = useStickyScroll<HTMLUListElement>(messages);

  const add = (who: Message["who"], text: string) => setMessages((m) => [...m, { id: next.current++, who, text }]);

  // Tell the server the chat is over, so it is summarized and filed (also when the page is closed).
  const finish = (id: string | null) => {
    if (!id) return;
    try {
      navigator.sendBeacon(`/api/embed/${agentId}/chat/end`, new Blob([JSON.stringify({ session: id })], { type: "application/json" }));
    } catch { /* it will finish by itself after a few quiet minutes */ }
  };
  useEffect(() => {
    live.current = phase === "open" ? session : null;
  }, [phase, session]);
  useEffect(() => {
    const leave = () => finish(live.current);
    window.addEventListener("pagehide", leave);
    return () => { window.removeEventListener("pagehide", leave); leave(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function begin() {
    setError(null);
    setPhase("starting");
    try {
      const res = await fetch(`/api/embed/${agentId}/chat/start`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.session) {
        setError(START_ERRORS[body.error as string] ?? "We couldn't start the chat. Please try again in a minute.");
        setPhase("idle");
        return;
      }
      setSession(body.session);
      setMessages([{ id: next.current++, who: "agent", text: String(body.greeting ?? "") }]);
      setPhase("open");
      setTimeout(() => input.current?.focus(), 50);
    } catch {
      setError("We couldn't start the chat. Check your connection and try again.");
      setPhase("idle");
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || waiting || !session) return;
    setError(null);
    setDraft("");
    add("you", text);
    setWaiting(true);
    try {
      const res = await fetch(`/api/embed/${agentId}/chat/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, message: text }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && typeof body.reply === "string") {
        add("agent", body.reply);
      } else {
        setError(SEND_ERRORS[body.error as string] ?? "That didn't go through. Please send it again.");
        if (body.error === "gone" || body.error === "limit") setPhase("ended");
        else setDraft(text);
        setMessages((m) => m.slice(0, -1)); // the unsent message goes back in the box
      }
    } catch {
      setError("That didn't go through. Check your connection and send it again.");
      setDraft(text);
      setMessages((m) => m.slice(0, -1));
    } finally {
      setWaiting(false);
      setTimeout(() => input.current?.focus(), 30);
    }
  }

  function end() {
    finish(session);
    setPhase("ended");
    setSession(null);
  }

  if (phase === "idle" || phase === "starting") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">You&apos;ll be chatting with an AI assistant. Type your questions, and it will answer.</p>
        <div><button className="btn btn-primary" onClick={begin} disabled={phase === "starting"}>{phase === "starting" ? "Starting…" : "Start chatting"}</button></div>
        <p role="alert" className="text-sm text-danger empty:sr-only">{error ?? ""}</p>
        <Disclosure />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <ul ref={logRef} onScroll={onScroll} role="log" aria-label="Conversation" aria-live="polite" className="min-h-40 flex-1 space-y-2 overflow-y-auto rounded-2xl border border-line p-3">
        {messages.map((m) => (
          <li key={m.id} className={`flex ${m.who === "you" ? "justify-end" : ""}`}>
            <span className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${m.who === "you" ? "bg-accent/25" : "bg-white/10"}`}>
              <span className="sr-only">{m.who === "you" ? "You: " : "Assistant: "}</span>{m.text}
            </span>
          </li>
        ))}
        {waiting && <li className="text-sm text-muted" aria-label="The assistant is typing">Typing…</li>}
      </ul>

      {phase === "open" ? (
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <label htmlFor="chat-draft" className="sr-only">Your message</label>
          <textarea
            id="chat-draft" ref={input} rows={2} maxLength={MAX} value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            className="field min-h-0 flex-1 resize-none" placeholder="Type your message"
          />
          <button className="btn btn-primary" disabled={waiting || !draft.trim()}>Send</button>
        </form>
      ) : (
        <p className="text-sm text-muted">This chat has ended. Thanks for chatting.</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {phase === "open" ? (
          <button type="button" className="btn btn-quiet" onClick={end}>End chat</button>
        ) : (
          <button type="button" className="btn" onClick={() => { setPhase("idle"); setError(null); }}>Chat again</button>
        )}
        <p role="alert" className="text-sm text-danger empty:sr-only">{error ?? ""}</p>
      </div>
      <Disclosure />
    </div>
  );
}

const Disclosure = () => (
  <p className="text-xs text-faint">
    This chat is saved so the business can follow up. Don&apos;t share anything you wouldn&apos;t want saved.
  </p>
);
