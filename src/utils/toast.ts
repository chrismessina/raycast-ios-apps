import * as kit from "@chrismessina/raycast-kit";
import { open, Toast } from "@raycast/api";
import { AppleAccountActionError } from "./errors";

/**
 * The extension's only door to raycast-kit's failure toasts (eslint.config.mjs
 * bans importing them anywhere else). When the error is Apple's sign-in dialog,
 * the toast's action opens the apple.com page the dialog points at, in place of
 * any action the caller passed: no other action helps with that error.
 */

/** The action that opens Apple's page for a sign-in dialog error, or `undefined`. */
export function appleAccountAction(error: unknown): Toast.ActionOptions | undefined {
  if (!(error instanceof AppleAccountActionError)) return undefined;
  return { title: error.actionTitle, onAction: () => void open(error.url) };
}

function withAppleAction(error: unknown, options: kit.ShowErrorOptions): kit.ShowErrorOptions {
  const action = appleAccountAction(error);
  return action ? { ...options, action } : options;
}

export function showError(error: unknown, options: kit.ShowErrorOptions): Promise<Toast | undefined> {
  return kit.showError(error, withAppleAction(error, options));
}

export function failToast(toast: Toast, error: unknown, options: kit.ShowErrorOptions): boolean {
  return kit.failToast(toast, error, withAppleAction(error, options));
}
