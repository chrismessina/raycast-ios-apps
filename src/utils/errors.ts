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
