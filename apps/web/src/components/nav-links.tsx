"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { confirmLeave } from "@/lib/unsaved";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/agents", label: "Agents" },
  { href: "/calls", label: "Calls" },
  { href: "/numbers", label: "Numbers" },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="ml-0 mr-auto flex min-w-0 gap-0 text-[0.8125rem] sm:ml-6 sm:gap-1 sm:text-sm">
      {LINKS.map((l) => {
        const active = path === l.href || path.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            onClick={(e) => { if (!confirmLeave()) e.preventDefault(); }}
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
