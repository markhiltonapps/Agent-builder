"use client";

import { signOut } from "@/app/actions";
import { confirmLeave } from "@/lib/unsaved";

export function SignOutButton() {
  return (
    <form action={signOut} onSubmit={(e) => { if (!confirmLeave()) e.preventDefault(); }}>
      <button className="btn btn-quiet whitespace-nowrap max-sm:px-2">Sign out</button>
    </form>
  );
}
