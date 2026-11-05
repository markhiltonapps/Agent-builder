// A promise-based confirmation, shown by <ConfirmHost/> as a glass dialog instead of the
// browser's plain pop-up: `if (!(await askConfirm({ title: "Publish?" }))) return;`

export interface ConfirmOptions {
  title: string;
  body?: string;
  /** A highlighted extra line, for a warning the person should not miss. */
  note?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" makes the confirm button red and puts focus on Cancel. */
  tone?: "default" | "danger";
}

export interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export const CONFIRM_EVENT = "neato:confirm";

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent<ConfirmRequest>(CONFIRM_EVENT, { detail: { ...opts, resolve } }));
  });
}

/** "Title\n\nBody" -> options. Handy where the text was written as one string. */
export function fromText(text: string, extra: Partial<ConfirmOptions> = {}): ConfirmOptions {
  const [title, ...rest] = text.split("\n\n");
  return { title, body: rest.join("\n\n") || undefined, ...extra };
}
