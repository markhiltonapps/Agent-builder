"use client";

import { signOut } from "@/app/actions";
import { leaveIfSafe } from "@/lib/unsaved";

export function SignOutButton() {
  return (
    <form action={signOut} onSubmit={(e) => { const form = e.currentTarget; leaveIfSafe(e, () => form.requestSubmit()); }}>
      <button className="btn btn-quiet whitespace-nowrap max-sm:px-2">Sign out</button>
    </form>
  );
}
