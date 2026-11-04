// Whether the editor holds unsaved work. A plain module value, not React state: the main
// navigation and Sign out live outside the editor and only need to ask at click time.
let unsaved = false;

export const setUnsaved = (value: boolean) => {
  unsaved = value;
};

/** True if it is fine to leave: nothing unsaved, or the person agreed to discard it. */
export function confirmLeave(): boolean {
  return !unsaved || window.confirm("You have unsaved changes. Leave without saving?");
}
