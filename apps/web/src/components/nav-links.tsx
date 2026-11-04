"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { confirmLeave } from "@/lib/unsaved";

const LINKS = [
  { href: "/agents", label: "Agents" },
  { href: "/calls", label: "Calls" },
  { href: "/numbers", label: "Numbers" },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="ml-3 mr-auto flex gap-1 text-sm sm:ml-6">
      {LINKS.map((l) => {
        const active = path === l.href || path.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            onClick={(e) => { if (!confirmLeave()) e.preventDefault(); }}
            className={`rounded-md px-3 py-2 transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-accent ${
              active ? "bg-white/10 text-text" : "text-muted"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
