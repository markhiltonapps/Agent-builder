"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { duration } from "@/lib/format";

type Kind = "int" | "percent" | "clock";

const show = (kind: Kind, n: number) =>
  kind === "percent" ? `${Math.round(n)}%` : kind === "clock" ? duration(n) : String(Math.round(n));

const QUIET = "(prefers-reduced-motion: reduce)";
function usePrefersReducedMotion() {
  return useSyncExternalStore(
    (notify) => {
      const m = window.matchMedia(QUIET);
      m.addEventListener("change", notify);
      return () => m.removeEventListener("change", notify);
    },
    () => window.matchMedia(QUIET).matches,
    () => false,
  );
}

/**
 * A number that counts up from zero when it appears. Screen readers get the final value at once
 * (the counting is hidden from them), and people who prefer reduced motion see it without counting.
 */
export function CountUp({ to, kind = "int", delayMs = 0, durationMs = 1000 }: { to: number; kind?: Kind; delayMs?: number; durationMs?: number }) {
  const [n, setN] = useState(0);
  const still = usePrefersReducedMotion() || to === 0;
  useEffect(() => {
    if (still) return;
    let raf = 0;
    const timer = setTimeout(() => {
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        setN(to * (1 - Math.pow(1 - t, 3))); // ease out: fast at first, settling at the end
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delayMs);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [to, still, delayMs, durationMs]);
  return (
    <>
      <span className="sr-only">{show(kind, to)}</span>
      <span aria-hidden="true">{show(kind, still ? to : n)}</span>
    </>
  );
}
