"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Remembers the viewer's time zone in a cookie so server pages can cut days on their clock. */
export function TimeZoneCookie({ current }: { current: string }) {
  const router = useRouter();
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && tz !== current) {
        document.cookie = `tz=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
      }
    } catch {
      /* the page still works in UTC */
    }
  }, [current, router]);
  return null;
}
