"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CONFIRM_EVENT, type ConfirmRequest } from "@/lib/dialog";

/** The one confirmation dialog for the whole app. A native <dialog>, so focus is trapped, Escape
 *  closes it, the page behind is inert, and focus returns to where it was. */
export function ConfirmHost() {
  const ref = useRef<HTMLDialogElement>(null);
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const reqRef = useRef<ConfirmRequest | null>(null);
  const titleId = useId();
  const bodyId = useId();

  const finish = useCallback((ok: boolean) => {
    const current = reqRef.current;
    reqRef.current = null;
    ref.current?.close();
    setReq(null);
    current?.resolve(ok);
  }, []);

  useEffect(() => {
    const on = (e: Event) => {
      reqRef.current?.resolve(false); // a newer question replaces an unanswered one
      const next = (e as CustomEvent<ConfirmRequest>).detail;
      reqRef.current = next;
      setReq(next);
    };
    window.addEventListener(CONFIRM_EVENT, on);
    return () => window.removeEventListener(CONFIRM_EVENT, on);
  }, []);

  useEffect(() => {
    if (!req || !ref.current) return;
    if (!ref.current.open) ref.current.showModal();
    // A native dialog focuses its first button; the safe default may be the other one.
    ref.current.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [req]);

  const danger = req?.tone === "danger";
  return (
    <dialog
      ref={ref}
      className="glass-dialog"
      aria-labelledby={titleId}
      aria-describedby={req?.body ? bodyId : undefined}
      onCancel={(e) => { e.preventDefault(); finish(false); }}
      onClick={(e) => { if (e.target === ref.current) finish(false); }}
    >
      {req && (
        <div className="glass space-y-4 p-6">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">{req.title}</h2>
          {req.body && <p id={bodyId} className="whitespace-pre-line text-sm text-muted">{req.body}</p>}
          {req.note && (
            <p className="rounded-2xl border border-warn/40 bg-warn/10 p-3 text-sm" role="note">{req.note}</p>
          )}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button type="button" className="btn" onClick={() => finish(false)} data-autofocus={danger ? "" : undefined}>
              {req.cancelLabel ?? "Cancel"}
            </button>
            <button type="button" className={`btn ${danger ? "btn-danger-solid" : "btn-primary"}`} onClick={() => finish(true)} data-autofocus={danger ? undefined : ""}>
              {req.confirmLabel ?? "OK"}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
