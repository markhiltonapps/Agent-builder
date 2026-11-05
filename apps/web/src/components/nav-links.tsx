"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { leaveIfSafe } from "@/lib/unsaved";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/agents", label: "Agents" },
  { href: "/knowledge", label: "Knowledge" },
  { href: "/clients", label: "Clients" },
  { href: "/calls", label: "Calls" },
  { href: "/usage", label: "Usage" },
  { href: "/numbers", label: "Numbers" },
  { href: "/help", label: "Help" },
];

export function NavLinks() {
  const path = usePathname();
  const router = useRouter();
  return (
    <nav aria-label="Main" className="ml-0 mr-auto flex min-w-0 gap-0 overflow-x-auto text-[0.8125rem] sm:ml-6 sm:gap-1 sm:text-sm">
      {LINKS.map((l) => {
        const active = path === l.href || path.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            onClick={(e) => leaveIfSafe(e, () => router.push(l.href))}
            className={`nav-pill px-2 py-2 sm:px-4 hover:text-text focus-visible:outline-2 focus-visible:outline-accent ${
              active ? "" : "text-muted"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
