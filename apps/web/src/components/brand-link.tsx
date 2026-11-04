"use client";

import Link from "next/link";
import { confirmLeave } from "@/lib/unsaved";

export function BrandLink() {
  return (
    <Link
      href="/agents"
      onClick={(e) => { if (!confirmLeave()) e.preventDefault(); }}
      className="flex items-center gap-2 whitespace-nowrap font-semibold tracking-tight"
    >
      <span aria-hidden className="inline-block size-2.5 rounded-full bg-accent" />
      <span>
        Neato<span className="hidden sm:inline"> Agent Builder</span>
      </span>
    </Link>
  );
}
