"use client";

import { useFormStatus } from "react-dom";

/** Disabled while the copy is being made, so a double click cannot create two. */
export function DuplicateButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn" disabled={pending}>
      {pending ? "Copying…" : "Duplicate"}
    </button>
  );
}
