import { askConfirm } from "./dialog";

// Whether the editor holds unsaved work. A plain module value, not React state: the main
// navigation and Sign out live outside the editor and only need to ask at click time.
let unsaved = false;

export const setUnsaved = (value: boolean) => {
  unsaved = value;
};

/**
 * Call from a click or submit handler. With nothing unsaved the event goes through untouched.
 * Otherwise it is held, the person is asked, and `proceed` runs only if they agree to leave.
 */
export function leaveIfSafe(e: { preventDefault(): void }, proceed: () => void) {
  if (!unsaved) return;
  e.preventDefault();
  void askConfirm({
    title: "Leave without saving?",
    body: "You have unsaved changes. If you leave now, they will be lost.",
    confirmLabel: "Leave without saving",
    cancelLabel: "Keep editing",
    tone: "danger",
  }).then((ok) => {
    if (!ok) return;
    unsaved = false;
    proceed();
  });
}
