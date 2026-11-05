"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { switchClient } from "@/app/actions";
import { hasUnsaved, leaveIfSafe } from "@/lib/unsaved";

/** Which client you are working in. Only shown when there is more than one. */
export function ClientSwitcher({ clients, currentId }: { clients: { id: string; name: string }[]; currentId: string }) {
  const router = useRouter();
  const path = usePathname();
  const [pending, start] = useTransition();
  if (clients.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only sm:not-sr-only text-muted">Client</span>
      <select
        className="field !w-auto max-w-[14rem] !rounded-full !py-1.5 !pr-8 text-sm"
        value={currentId}
        disabled={pending}
        aria-label="Client you are working in"
        onChange={(e) => {
          const id = e.target.value;
          const go = () => start(async () => {
            await switchClient(id);
            // a page that belongs to the client you just left (one agent, one call) would be stale
            if (/^\/(agents|calls)\/[^/]+/.test(path) && path !== "/agents/new") router.push(path.startsWith("/calls") ? "/calls" : "/agents");
            else router.refresh();
          });
          if (hasUnsaved()) leaveIfSafe(e, go);
          else go();
        }}
      >
        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}
