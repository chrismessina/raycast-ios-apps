# Robust Apple Auth for ipatool Downloads

Harden the Apple ID authentication and 2FA flow to prevent crashes, handle expired sessions gracefully, and meet Raycast Store review requirements.

Based on analysis of ipatool v2.3.0 source (`cmd/auth.go`, `pkg/appstore/appstore_login.go`, `pkg/appstore/constants.go`, `cmd/download.go`).

---

## Issues (18 total, grouped by severity)

### Crash Bugs (3) — extension terminates with "Uncaught Extension Exception"

| #   | Location                     | Issue                                                                                                                                                          |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `use-auth-navigation.tsx:65` | `throw error` in async `onSubmit` — non-2FA login errors (wrong password, network) re-thrown inside Raycast Form handler with no error boundary → crash        |
| C2  | `use-auth-navigation.tsx:23` | `await loginToAppleId(undefined, undefined, code)` in 2FA form's `onSubmit` has **zero** error handling — wrong code, expired code, or network failure → crash |
| C3  | `AppleTwoFactorForm.tsx:37`  | `onSubmit({ code })` called without `await` — async errors become unhandled promise rejections → crash                                                         |

### 2FA Flow Gaps (6) — likely what Raycast reviewers flagged

| #   | Location   | Issue                                                                                                             |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| F1  | Both forms | **No loading state** — no indicator while auth request is in flight; user can double-submit                       |
| F2  | Both forms | **No inline error feedback** — when login/2FA fails, user sees nothing (or a crash)                               |
| F3  | 2FA form   | **Wrong code not recoverable** — form doesn't stay open with error; user can't retry                              |
| F4  | 2FA form   | **Expired code not handled** — no "code expired, request a new one" guidance                                      |
| F5  | Login form | **Apple ID not pre-filled** — on session expiry re-auth, user must re-type their email even though it's stored    |
| F6  | Both forms | **No `navigationTitle`** — Raycast nav bar shows generic title instead of "Sign In" / "Two-Factor Authentication" |

### Auth State Management (5)

| #   | Location                               | Issue                                                                                                                                                                                                                  |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `auth.ts` `invalidateAuthentication()` | Nukes Apple ID + password on ANY auth error, including session expiry — should only revoke ipatool session                                                                                                             |
| S2  | `auth.ts` `loginToAppleId()`           | No `ipatool auth revoke` before re-login on session expiry — stale keyring entries can conflict                                                                                                                        |
| S3  | `auth.ts` `loginToAppleId()`           | **Exit code 0 + 2FA required not detected.** ipatool returns exit 0 in non-interactive mode when 2FA is needed (prints message, returns nil). `executeSecureIpatoolCommand` sees success, never throws `Needs2FAError` |
| S4  | `auth.ts` vs `ipatool-auth.ts`         | Duplicate login logic — `auth.ts:loginToAppleId()` uses sync spawnSync, `ipatool-auth.ts:login()` uses async spawn with real-time 2FA detection. The async version handles S3 correctly; the sync version does not     |
| S5  | `auth.ts` `ensureAuthenticated()`      | Trusts `ipatool auth info` which only checks local keyring — stale tokens appear valid after password change                                                                                                           |

### Download-Time Auth Errors (3)

| #   | Location                  | Issue                                                                                                       |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| D1  | `use-app-download.ts:180` | "Downloading... 0%" toast appears before download command runs — misleading when download immediately fails |
| D2  | `use-app-download.ts:312` | Progress toast not dismissed when auth error caught — stays visible behind login form                       |
| D3  | `tools/download-app.ts`   | AI tool commands can't push login forms — should return clear "please authenticate first" message           |

### Error Pattern Gap (1)

| #   | Location                        | Issue                                                                                                                                                                                                                                               |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | `ipatool-error-patterns.ts:101` | `"sign in to the itunes store"` matched by the broad credentials block and classified as `isCredentialError: true` — triggers full credential wipe when it's actually a session-expired error (ipatool FailureType `2034` / `PasswordTokenExpired`) |

---

## ipatool v2.3.0 Auth Behavior (reference)

Key behaviors from the source that inform this plan:

1. **FailureType constants** (from `constants.go`):
   - `-5000` = InvalidCredentials (bad email/password)
   - `2034` = PasswordTokenExpired (session expired, needs re-login)
   - `9610` = LicenseNotFound (app not purchased)
   - `2059` = TemporarilyUnavailable (server issues)

2. **2FA detection**: When `FailureType == ""` AND `CustomerMessage == "MZFinance.BadLogin.Configurator_message"` AND no auth code provided → `ErrAuthCodeRequired`. In non-interactive mode, ipatool prints "2FA code is required; run the command again..." and **returns exit code 0** (not an error).

3. **Auth code is concatenated to password**: `password + authCode` sent as single field. The `--auth-code` CLI flag handles this.

4. **Download auto-retries on expired token**: `cmd/download.go` catches `ErrPasswordTokenExpired` and retries with `Login()` using stored account credentials. The extension only sees this error if the internal retry also fails.

5. **`auth info` checks local keyring only**: Does not validate the token against Apple servers.

---

## Plan

### Step 1 — Consolidate login onto `ipatool-auth.ts:login()` (S3, S4)

**Files:** `auth.ts`, `ipatool-auth.ts`

The async `login()` in `ipatool-auth.ts` correctly handles the exit-code-0-but-2FA-needed case via real-time output detection. The sync `loginToAppleId()` in `auth.ts` misses this entirely.

- Refactor `auth.ts:loginToAppleId()` to delegate to `ipatool-auth.ts:login()` instead of calling `executeSecureIpatoolCommand` directly
- Map `LoginResult` to the existing error types: `{ needs2FA: true }` → throw `Needs2FAError`; `{ success: false }` → throw `NeedsLoginError` or `Error`
- Remove the duplicate `executeSecureIpatoolCommand(["auth", "login", ...])` call from `auth.ts`
- Add `logger.step()` calls to track the login flow: step 1 "resolving credentials", step 2 "calling ipatool login", step 3 "login result"
- Add `logger.time("loginToAppleId")` to measure total login duration

### Step 2 — Fix all three crash bugs (C1, C2, C3)

**Files:** `use-auth-navigation.tsx`, `AppleTwoFactorForm.tsx`

- **C1**: In `use-auth-navigation.tsx` `pushLoginForm` callback, replace `throw error` (line 65) with `showFailureToast(error, { title: "Login failed" })`. The form stays open so user can retry. Add `logger.error("[Auth] Login form submission failed", error)`.
- **C2**: In `use-auth-navigation.tsx` `push2FAForm` callback, wrap `loginToAppleId()` in try/catch. On error, show failure toast and keep form open. Add `logger.error("[Auth] 2FA verification failed", error)`.
- **C3**: In `AppleTwoFactorForm.tsx`, change `onSubmit({ code })` to `await onSubmit({ code })` inside a try/catch. Fix the `onSubmit` prop type from `(credentials: { code: string }) => void` to `(credentials: { code: string }) => void | Promise<void>`.
- Apply the same type fix to `AppleLoginForm.tsx`: `onSubmit` prop from `=> void` to `=> void | Promise<void>`.

### Step 3 — Add loading states and error feedback to both forms (F1, F2, F3, F4)

**Files:** `AppleLoginForm.tsx`, `AppleTwoFactorForm.tsx`, `use-auth-navigation.tsx`

- Add `isSubmitting` state to both forms; set `true` before calling `onSubmit`, `false` in `finally`
- Pass `isLoading={isSubmitting}` to `<Form>` to show Raycast's built-in loading indicator
- Disable submit action while `isSubmitting` is true (prevents double-submit)
- On login failure: show `showFailureToast` with error message, form stays open
- On 2FA failure: show `showFailureToast`, clear the code field, keep form open for retry
- On 2FA expired code: show toast "Code may have expired — try requesting a new one" + highlight the existing Resend Code action
- Add `logger.warn("[Auth] Form submission failed, keeping form open for retry")` on recoverable errors

### Step 4 — Pre-fill Apple ID and add navigation titles (F5, F6)

**Files:** `AppleLoginForm.tsx`, `AppleTwoFactorForm.tsx`, `use-auth-navigation.tsx`

- `AppleLoginForm`: accept optional `initialEmail` prop; initialize `email` state from it
- `use-auth-navigation.tsx` `pushLoginForm`: call `getAppleIdFromStorage()` and pass result as `initialEmail`
- Both forms: add `navigationTitle` prop to `<Form>` — `"Sign In to Apple ID"` and `"Two-Factor Authentication"`

### Step 5 — Add session-expired and maintenance error patterns (E1)

**File:** `ipatool-error-patterns.ts`

- Add `"session_expired"` to the `errorType` union type
- Add pattern for FailureType `2034` (`PasswordTokenExpired`): match `failuretype.*2034` or `password.*token.*expired`
  - Classify as `isAuthError: true, isCredentialError: false, errorType: "session_expired"`
  - `userMessage`: "Your session has expired. Please sign in again."
  - `suggestedAction`: "Sign In"
- Add pattern for FailureType `2059` (`TemporarilyUnavailable`): match `failuretype.*2059`
  - Classify as `errorType: "maintenance"`
- Move the `"sign in to the itunes store"` string OUT of the broad credentials block (line 101) and into a new session-expired block that checks for the absence of explicit credential failure indicators
- Ensure pattern ordering: specific FailureType patterns match BEFORE the broad auth/credentials fallback
- Add `logger.debug("[ErrorPatterns] Classified error", { errorType, isAuthError, isCredentialError })` for diagnostics

### Step 6 — Smarter credential invalidation (S1)

**Files:** `auth.ts`, `error-handler.ts`

- New `invalidateSession()` function: calls `ipatool auth revoke` (via `ipatool-auth.ts:revoke()`) but **keeps** Apple ID + password in storage
  - Add `logger.info("[Auth] Invalidating session (keeping stored credentials)")`
- Modify `invalidateAuthentication()`: delegate to `invalidateSession()` by default; only call `clearStoredCredentials()` when `{ clearCredentials: true }` is passed
- `error-handler.ts` `handleAuthError()`: use `invalidateSession()` for `errorType: "session_expired"`; only full-wipe for `errorType: "credentials"`
- `logout.ts`: explicitly pass `{ clearCredentials: true }` since logout should always fully wipe
- Add `logger.step()` tracking through the invalidation flow

### Step 7 — Revoke stale auth before re-login on session expiry (S2)

**File:** `auth.ts`

- In `loginToAppleId()`, when called for re-authentication (detected by: stored credentials exist AND no explicit email/password params passed), call `ipatool-auth.ts:revoke()` best-effort before login
- Only on session-expiry re-auth, NOT on first login (avoid unnecessary latency)
- Add `logger.log("[Auth] Revoking stale session before re-login")`

### Step 8 — Dismiss progress toast on auth errors, lazy toast creation (D1, D2)

**File:** `use-app-download.ts`

- **D2**: When catching `NeedsLoginError`/`Needs2FAError` in the download flow, call `progressToast?.hide()` before pushing the login form
- **D1**: Defer progress toast — don't show "Downloading... 0%" until the first `onProgress` callback fires. If download fails before any progress, user sees the error toast directly instead of a misleading progress indicator
- Add `logger.log("[Download] Auth error during download, dismissing progress toast")` when hiding toast

### Step 9 — Tool command auth error messaging (D3)

**File:** `tools/download-app.ts`

- When `downloadApp()` or `ensureAuthenticated()` throws `NeedsLoginError` or `Needs2FAError`, return a structured response:

  ```typescript
  {
    success: false,
    message: "Authentication required. Please run the 'Search iOS Apps' command and sign in with your Apple ID first.",
    requiresAuth: true
  }
  ```

- Add `logger.warn("[Tool:download-app] Auth required but cannot show login form in tool context")` so this failure mode is trackable

---

## Files Changed (summary)

| File                                          | Steps   | Changes                                                                      |
| --------------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `src/utils/auth.ts`                           | 1, 6, 7 | Delegate login to ipatool-auth, `invalidateSession()`, revoke-before-relogin |
| `src/utils/ipatool-auth.ts`                   | 1       | May need minor API adjustments to support delegation                         |
| `src/hooks/use-auth-navigation.tsx`           | 2, 3, 4 | Error handling, loading state, pre-fill email, nav titles                    |
| `src/components/forms/AppleLoginForm.tsx`     | 2, 3, 4 | Async onSubmit type, `isSubmitting`, `initialEmail`, `navigationTitle`       |
| `src/components/forms/AppleTwoFactorForm.tsx` | 2, 3, 4 | Await + try/catch, `isSubmitting`, error recovery, `navigationTitle`         |
| `src/utils/ipatool-error-patterns.ts`         | 5       | `session_expired` pattern for FailureType 2034, reorder patterns             |
| `src/utils/error-handler.ts`                  | 6       | Use `invalidateSession()` for session errors                                 |
| `src/logout.ts`                               | 6       | Explicit `{ clearCredentials: true }` on logout                              |
| `src/hooks/use-app-download.ts`               | 8       | Dismiss toast on auth error, lazy toast creation                             |
| `src/tools/download-app.ts`                   | 9       | Structured auth-required response for AI tools                               |

## Logging Strategy

All auth-related changes use `@chrismessina/raycast-logger` consistently:

- **`logger.step()`** — track multi-phase flows (login sequence, invalidation flow)
- **`logger.time()`** — measure login and auth verification duration
- **`logger.error()`** — all error paths (always visible regardless of verbose setting)
- **`logger.warn()`** — recoverable issues (form retry, tool auth fallback)
- **`logger.info()`** — significant state changes (session invalidated, credentials cleared)
- **`logger.log()`** — diagnostic detail (verbose-only: auth checks, toast management)
- **`logger.debug()`** — error classification detail (verbose-only)

The logger automatically redacts passwords, auth codes, emails, and tokens — no manual sanitization needed for log calls in the auth flow.

## Implementation Order

Steps 1-4 are tightly coupled and should be implemented together as one unit. Step 5 (error patterns) is a prerequisite for step 6 (smarter invalidation). Steps 7-9 are independent and can be done in any order after steps 1-6.
