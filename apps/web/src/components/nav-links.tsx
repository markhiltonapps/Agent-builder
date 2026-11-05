"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type NavItem, isActive } from "@/lib/nav";
import { leaveIfSafe } from "@/lib/unsaved";

/** A row of pill links; the one for the page you are on is marked. */
export function NavLinks({ links, label, bare }: { links: readonly NavItem[]; label: string; bare?: boolean }) {
  const path = usePathname();
  const router = useRouter();
  return (
    <nav
      aria-label={label}
      className={`flex min-w-0 gap-0 overflow-x-auto text-[0.8125rem] sm:text-sm ${bare ? "sm:gap-1" : "ml-0 mr-auto sm:ml-6 sm:gap-1"}`}
    >
      {links.map((l) => {
        const active = isActive(path, l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            onClick={(e) => leaveIfSafe(e, () => router.push(l.href))}
            className={`nav-pill whitespace-nowrap px-2 py-2 sm:px-4 hover:text-text focus-visible:outline-2 focus-visible:outline-accent ${
              active ? "" : "text-muted"
            }`}
          >
            {l.back && <span aria-hidden>◂ </span>}
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
