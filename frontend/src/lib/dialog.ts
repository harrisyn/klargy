/**
 * Styled replacements for window.confirm / window.prompt. Call from anywhere
 * and await the answer; <DialogHost /> in the root layout shows them.
 *
 *   if (!(await confirmDialog({ title: 'Delete plan?', message: '...', tone: 'danger' }))) return;
 */
export type DialogTone = 'default' | 'danger';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
  /** The person must type this exactly before the confirm button unlocks. */
  requireText?: string;
}

export interface PromptOptions {
  title: string;
  message?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
  multiline?: boolean;
}

export type DialogRequest =
  | ({ id: number; kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOptions)
  | ({ id: number; kind: 'prompt'; resolve: (value: string | null) => void } & PromptOptions);

export const DIALOG_EVENT = 'qms-dialog';

let counter = 0;

/** Resolves true on confirm, false on cancel or dismiss. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent<DialogRequest>(DIALOG_EVENT, { detail: { ...options, id: ++counter, kind: 'confirm', resolve } }));
  });
}

/** Resolves the entered text (possibly empty) on confirm, null on cancel. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent<DialogRequest>(DIALOG_EVENT, { detail: { ...options, id: ++counter, kind: 'prompt', resolve } }));
  });
}
