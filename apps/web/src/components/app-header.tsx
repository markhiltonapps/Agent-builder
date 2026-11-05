"use client";

import { usePathname } from "next/navigation";
import { BrandLink } from "@/components/brand-link";
import { ClientSwitcher } from "@/components/client-switcher";
import { NavLinks } from "@/components/nav-links";
import { SignOutButton } from "@/components/sign-out-button";
import { ADMIN_LINKS, CLIENT_TABS, CLIENT_TOP_LINKS, levelOf } from "@/lib/nav";

/**
 * The top of every page. On the admin level (all clients, all calls, usage) the bar has the admin menu.
 * Inside a client it shows a way back to All clients, and a coloured bar under it names the client and
 * holds everything about that client, so it is always clear which one you are working in.
 */
export function AppHeader({ clients, current }: { clients: { id: string; name: string }[]; current: { id: string; name: string } | null }) {
  const inClient = levelOf(usePathname()) === "client" && current !== null;
  return (
    <header className="sticky top-0 z-20 px-3 pt-3 sm:px-6">
      <div className="glass glass-bar mx-auto flex h-14 max-w-[1500px] items-center px-2 sm:px-5">
        <BrandLink />
        <NavLinks links={inClient ? CLIENT_TOP_LINKS : ADMIN_LINKS} label="Main" />
        <SignOutButton />
      </div>
      {inClient && current && (
        <div className="mx-auto mt-2 max-w-[1500px] rounded-3xl border border-accent/40 bg-accent/10 px-3 py-2 backdrop-blur sm:px-5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-faint">Client</span>
              <span className="truncate text-base font-semibold">{current.name}</span>
              <ClientSwitcher clients={clients} currentId={current.id} label="Switch client" />
            </div>
            <NavLinks links={CLIENT_TABS} label="This client" bare />
          </div>
        </div>
      )}
    </header>
  );
}
