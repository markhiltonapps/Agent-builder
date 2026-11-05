import { useCallback, useEffect, useRef } from "react";

/** Is the box scrolled to (or within `slack` pixels of) its bottom? Pure, so it can be tested. */
export function nearBottom(scrollHeight: number, scrollTop: number, clientHeight: number, slack = 48): boolean {
  return scrollHeight - scrollTop - clientHeight < slack;
}

/**
 * A scrolling box that follows new content, like a chat or a live transcript. It sticks to the
 * bottom while the person is reading the latest lines, and lets go the moment they scroll up to
 * read something earlier (so it never yanks them back). Scrolling to the bottom picks it up again.
 */
export function useStickyScroll<T extends HTMLElement>(dependency: unknown) {
  const ref = useRef<T>(null);
  const stuck = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stuck.current = nearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [dependency]);

  return { ref, onScroll };
}
