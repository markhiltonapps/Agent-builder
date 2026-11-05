"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { leaveIfSafe } from "@/lib/unsaved";

export function BrandLink() {
  const router = useRouter();
  return (
    <Link
      href="/clients"
      onClick={(e) => leaveIfSafe(e, () => router.push("/clients"))}
      className="flex items-center justify-center gap-2 whitespace-nowrap font-semibold tracking-tight max-sm:hidden focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span aria-hidden className="inline-block size-2.5 rounded-full bg-accent" />
      <span>Neato Agent Builder</span>
    </Link>
  );
}
