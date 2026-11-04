"use client";

/** A timestamp in the viewer's own time zone. The server renders UTC; the client corrects it. */
export function LocalTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
    </time>
  );
}
