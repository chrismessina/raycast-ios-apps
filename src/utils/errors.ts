// Typed errors shared across the auth and download paths.
//
// A LEAF MODULE ON PURPOSE — it imports nothing. These classes used to live in
// auth.ts, but ipatool-auth.ts needs to throw one and auth.ts already imports
// ipatool-auth.ts, so importing them from there closed a require cycle. A cycle
// resolves fine only while every use happens after module init; a future
// top-level use would silently see `undefined`.

/**
 * Custom error types for authentication flow
 */
export class NeedsLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsLoginError";
  }
}

/**
 * What a `Needs2FAError` says when Apple has ALREADY sent a code — the case
 * where ipatool's own silent re-login was answered with a 2FA prompt. Kept free
 * of "authentication required", which `handleAuthError` reads as bad
 * credentials and answers by deleting the stored password the code needs.
 */
export const TWO_FACTOR_PROMPT_MESSAGE =
  "Apple sent a verification code to your devices. Enter it to finish signing in.";

export class Needs2FAError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Needs2FAError";
  }
}

/**
 * Thrown when ipatool reports that an app is not yet available for download
 * (typical signature: pre-release / "Coming Soon" titles whose listing exists
 * but whose purchase API returns "item is temporarily unavailable"). Carried
 * across the ipatool → hook boundary so the UI can show the specific
 * "Not Released Yet" message without re-parsing wrapped strings.
 */
export class NotYetReleasedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotYetReleasedError";
  }
}

/**
 * Thrown when the requested app is one of Apple's own built-in apps (Apple TV,
 * Wallet, Apple Music and friends — bundle IDs under `com.apple.`). The App
 * Store will not issue a license for these to a third-party client, so ipatool
 * can never download them; it is a permanent property of the app, not a
 * transient failure. Typed so callers can say that plainly instead of letting
 * the message fall through the generic analyzer and come out as
 * "Download failed: ... cannot be downloaded".
 */
export class BuiltInAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuiltInAppError";
  }
}

/**
 * Thrown when Apple answers a download or version request with HTTP 200 but an
 * empty product payload (`Items: []`, no `FailureType`, no `CustomerMessage`),
 * which ipatool surfaces as the bare string `invalid response`.
 *
 * It is per-app and not about the account: the app IS owned, and most other
 * apps download normally in the same session. Reproduced outside this
 * extension with `ipatool list-versions`, and reported upstream as
 * majd/ipatool#538. There is no client-side remedy, so retrying is pointless.
 */
export class AppleEmptyResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleEmptyResponseError";
  }
}

/**
 * Thrown when Apple refuses the App Store authentication handshake outright —
 * HTTP 403 (or 204) with an empty / non-plist body, from BOTH the native and
 * the legacy MZFinance endpoints, *before* any credential is processed.
 *
 * This is a platform gate, not a credentials problem. Since Apple's change of
 * 2026-08-19/20 the store credential is a Privacy Pass token signed by a Secure
 * Enclave key behind FairPlay device attestation, gated by entitlements only
 * Apple's own signed `appstoreagent` holds (majd/ipatool#522, #523). Retrying
 * and re-authenticating cannot help, so this MUST NOT route to the sign-in form.
 */
export class AppleAuthGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleAuthGateError";
  }
}

/** The user canceled a download from its progress toast. Not a failure. */
export class DownloadCanceledError extends Error {
  constructor(message = "Download canceled") {
    super(message);
    this.name = "DownloadCanceledError";
  }
}

/**
 * Apple answered a sign-in with a dialog that needs the user to act on
 * apple.com (reset a password, unlock an account). ipatool 2.8.1+ prints it as
 * `<message>: <explanation> (<button>: https://….apple.com/…)`, and only keeps
 * links on apple.com over https. Typed at the origin so the toast can offer the
 * link instead of the friendly-message mapping swallowing it.
 */
export class AppleAccountActionError extends Error {
  readonly actionTitle: string;
  readonly url: string;

  constructor(message: string, actionTitle: string, url: string) {
    super(message);
    this.name = "AppleAccountActionError";
    this.actionTitle = actionTitle;
    this.url = url;
  }
}

// The whole dialog shape ipatool prints: "message: explanation (Label: URL)",
// with the link closing the line. A bare "(Label: URL)" is not enough.
const DIALOG_ACTION = /^(.+?:\s.+?)\s*\(([^():]+): (https:\/\/(?:[a-z0-9-]+\.)*apple\.com(?:\/[^\s)]*)?)\)\s*$/i;

/**
 * Read Apple's dialog out of ipatool's sign-in output, or `undefined`. Each line
 * may be a JSON log record (`--format json`), whose `error` field holds the text
 * with Go's escaping undone; a plain line is read as is.
 */
export function parseAppleAccountAction(output: string): AppleAccountActionError | undefined {
  for (const line of output.split(/\r?\n/)) {
    let text = line.trim();
    try {
      const record: unknown = JSON.parse(text);
      // A JSON record counts only through its `error` field.
      if (!record || typeof record !== "object") continue;
      const field = (record as { error?: unknown }).error;
      if (typeof field !== "string") continue;
      text = field.trim();
    } catch {
      // Not JSON; use the raw line.
    }
    const match = DIALOG_ACTION.exec(text);
    if (!match) continue;
    return new AppleAccountActionError(match[1].trim(), match[2].trim(), match[3]);
  }
  return undefined;
}
