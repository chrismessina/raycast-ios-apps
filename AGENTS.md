# AGENTS.md

Guidance for coding agents working in this repository. Cite paths repo-relative — this file ships
with the extension, so an absolute path here publishes a machine path.

## Project Overview

A Raycast extension for searching, viewing, and downloading iOS apps from the App Store. Uses `ipatool` (CLI, v2.6.0+) for App Store auth/downloads and the iTunes Search API + App Store web scraping (shoebox JSON) for rich metadata and screenshots.

## Commands

```bash
npm run dev       # Start Raycast development server (ray develop)
npm run build     # Build the extension (ray build)
npm run lint      # Lint with ray lint
npm run fix-lint  # Auto-fix lint issues
npm run evals     # Run Raycast AI evals (scenarios in ai.yaml)
npm run publish   # Publish to the Raycast Store
```

There is no test runner. The pure download decisions have a plain-Node test: `node --experimental-strip-types src/utils/ipa-job.test.mjs` (likewise `download-layout.test.mjs`). The `ray` CLI must be on PATH.

## Architecture

### Data Flow

Three sources, and **which one searches depends on the caller**:

1. **ipatool** (`src/ipatool.ts`) — wraps the `ipatool` CLI for authentication, IPA downloads, purchases, and `searchApps()`. Manages auth state including 2FA.
2. **iTunes API** (`src/utils/itunes-api.ts`) — ratings, icons, screenshots, descriptions via `itunes.apple.com`.
3. **App Store Scraper** (`src/utils/app-store-scraper.ts`) — parses the `serialized-server-data` JSON blob out of App Store web pages for high-resolution screenshots by platform. (The exported helper is still named `extractScreenshotsFromShoeboxJson` and the prose in that file still says "shoebox" in places — shoebox is the structure Apple deprecated in the 2024 redesign, and the parser has not targeted it since.) Apple may change this at any time; parsing is designed to fail gracefully.

The **Search command** does not use ipatool at all: `src/hooks/use-app-search.ts` queries iTunes (lookup by ID/bundle ID/URL, falling back to term search) and maps results straight to `AppDetails`. The **AI tools** are the ipatool search path — `src/tools/search-apps.ts` calls `searchApps()` and enriches each hit via `enrichAppDetails()`.

`src/utils/app-search.ts` merges nothing; it is pure matching and ranking helpers (`filterRelevantApps`, `scoreAndSortIpaToolApps`, `getBestIpaToolMatch`, …) used by both paths.

### Key Layers

- **Commands** (entry points, declared in `package.json` "commands"): `src/search.tsx`, `src/favorites.tsx`, `src/purchased-apps.tsx`, `src/download-history.tsx`, `src/doctor.tsx`, `src/logout.ts`. Each runs in its **own JS context** with its own module-level state — nothing in memory is shared — but they all share **one pid**, the Raycast Backend's, so a pid never identifies a command or proves it is still alive. What IS shared: `LocalStorage`, the Keychain, and the downloads directory on disk. Downloads therefore never work IN that shared directory: each attempt writes into its own hidden `.ios-apps-op-*` directory inside it and only the verified artifact is renamed out (`createOperationDirectory` in `src/utils/download-lock.ts`). Do not add a sweep that matches files in the downloads directory by name — two commands downloading one app used to delete each other's live files that way.

  **An IPA download is detached.** `ipatool download` runs through `@chrismessina/raycast-downloader`'s `startCommand` (`src/utils/ipa-download-job.ts`), so it survives the Raycast window closing. The job id is `ipa-<bundleId>`; `startCommand` refuses a second one with `conflict`, which the extension maps to `DownloadInProgressError`. The old file lock is gone. Nothing in the starting command survives to finish the job, so: the attempt loop in `src/ipatool.ts` follows the job with `watchStatus` and, once it settles, interprets the exit and renames the artifact; a command that mounts `useAppDownload` (Search, Favorites, Purchased Apps, Download History and their detail views — not Doctor, Logout or the AI tools) while a job is on record re-attaches (`reattachDetachedDownloads` in `src/hooks/use-app-download.ts`, `adoptDownload` in `src/ipatool.ts`) and publishes it. Immediately before it starts a job, `runDownloadAttempt` refuses (`UnpublishedDownloadError`) when a finished, unpublished job for the same app is on record (`hasUnpublishedJob`), because `startCommand` under the same id would overwrite the only record of where that artifact sits. Publishing stays the re-attach path's job alone; a request that published inline was reviewed and rejected (it tangled two lifecycles and could delete the earlier artifact on cancel). A failed or canceled leftover is cleared instead. Adoption renames into the downloads directory recorded in the job's `meta`, not today's preference, since a rename across filesystems fails. A closed window gets exactly one attempt, with no retry or automatic license purchase, because the loop that did those died with it. One command follows a job: the holder of its package lease (`acquireLease`, 30s, renewed every 10s in `followIpaJob`). A second window waits in standby, showing progress, takes over when the lease lapses, and rejects with `JobFinishedElsewhereError` when the owner finishes; it never clears the status. History writes go through `appendToDownloadHistory`, which reads storage fresh on every write, because a download runs for minutes and state captured at render would overwrite one that finished meanwhile. The job's `meta` (bundle, name, platform, retry state, operation directory) carries what re-attaching needs and must never hold a credential. The operation directory is removed only after the job settles; `registerTempFile` must NOT be used on it, because the exit handler would delete a live download. The abandoned-directory sweep skips any directory a status still names (`shouldSweepOperationDir` in `src/utils/ipa-job.ts`).

  **The runner is a committed copy.** `assets/raycast-downloader-runner.js` is `node_modules/@chrismessina/raycast-downloader/dist/runner.bundle.js`, and the package looks for it under that name in `environment.assetsPath`. `ray publish` never re-copies it, and the package does not check that the runner matches its own release (a 0.2.x runner cannot run a command payload). Commit the copy, and re-copy it with every upgrade of the dependency.

- **AI Tools** (declared in `package.json` "tools", evals in `ai.yaml`): `src/tools/` — `search-apps`, `get-app-details`, `download-app`, `get-current-version`, `download-app-screenshots`. AI tools can show toasts and HUDs, but cannot push a **view** — there is no navigation stack, so a login form is impossible. They must surface auth state via return messages.
- **Views**: `src/views/app-detail-view.tsx`, `src/views/grid-search-view.tsx`, `src/views/developer-apps-view.tsx`
- **Components**: `src/components/` — action panels, copy/favorite/export actions, and `forms/` containing `AppleLoginForm` and `AppleTwoFactorForm` for in-UI auth.
- **Hooks**: `src/hooks/` — search, download, details, screenshots, favorites, history, purchased apps, recent searches, auth navigation, clipboard, version data. `index.ts` is a barrel for most of them, but **not** `use-auth-navigation` or `use-app-screenshots`; import those by path.
- **Utils**: `src/utils/` — ipatool wrappers, iTunes API, App Store scraper, screenshot/icon downloaders, temp file management, storage, formatting, paths, error patterns. raycast-kit failure toasts come only from `src/utils/toast.ts` (`showError`, `failToast`), never straight from `@chrismessina/raycast-kit`; `eslint.config.mjs` enforces it. The wrapper replaces the toast's action with Apple's link when the error is an `AppleAccountActionError` (ipatool 2.8.1's sign-in dialog, parsed in `src/utils/errors.ts`), so a new failure site gets the link without doing anything. Type it where ipatool's output is first read (`login` in `ipatool-auth.ts`, the download and purchase failure paths in `src/ipatool.ts`) and keep it typed up to the toast: a site that rebuilds it as `new Error(message)` loses the link.
- **Config**: `src/config.ts` — typed runtime config from Raycast preferences with defaults: download timeout, stall timeout, temp cleanup on exit, integrity verification, allowed screenshot domains. It does **not** own concurrency — the screenshot downloader reads its own limit from preferences directly. `maxDownloadTimeout` (the `downloadTimeoutSeconds` preference) now governs only screenshots and icons; an IPA download is bounded by `maxStallTimeout` alone, passed as `stallSeconds`, because a wall-clock ceiling killed any large IPA.
- **Types**: `src/types.ts` — all shared TypeScript interfaces (`AppDetails`, `ITunesResult`, `IpaToolSearchApp`, `PlatformType`, `ScreenshotInfo`, etc.). Avoid `any`; maintain strict typing per `tsconfig.json`.

### Auth Flow

Two parallel auth implementations exist — be aware of which to use:

- `src/utils/errors.ts` — all typed error classes: `NeedsLoginError`, `Needs2FAError`, `NotYetReleasedError`, `BuiltInAppError`, `AppleAuthGateError`, `AppleEmptyResponseError`. **This module must import nothing.** It is the leaf that keeps the graph acyclic: today `auth.ts → ipatool-auth.ts → errors.ts` and `auth.ts → errors.ts`, with `ipatool-auth.ts` no longer importing `auth.ts`. The cycle it was extracted to break was `auth.ts → ipatool-auth.ts → auth.ts`; adding an import here can reintroduce one. `auth.ts` re-exports these for compatibility.
- `src/utils/auth.ts` — higher-level auth orchestration, credential storage, `ensureAuthenticated()`, `loginToAppleId()`, `invalidateAuthentication()`. Also holds the 30s auth cache (`clearAuthenticationCache()`, `authGeneration`); `clearStoredCredentials()` must invalidate **before** its first `await`.
- `src/utils/ipatool-auth.ts` — async `login()` using `spawn`, detecting a 2FA prompt in real time from **stdout** (stderr is accumulated and inspected at process close). This is the path that correctly catches the case where ipatool exits 0 in non-interactive mode while requiring 2FA.

`src/hooks/use-auth-navigation.tsx` orchestrates the login → 2FA → authenticated UI flow, pushing `AppleLoginForm` / `AppleTwoFactorForm` as needed.

Credential storage:

- Apple ID → `LocalStorage` under key `appleId` (not sensitive).
- Password → macOS login Keychain, service `ios-apps-apple-password`, via `/usr/bin/security` (the `*KeychainPassword` helpers in `src/utils/auth.ts`). **`@raycast/api` has no Keychain API**; the code used to call one that does not exist, so until this fix nothing was ever saved. The password goes in over stdin, never argv, stored as UTF-8 hex, because `security -w` prints a non-ASCII password back as hex and an ASCII one raw. `saveCredentials(email, password)` writes both under that `email` and tries to delete the previous Apple ID's item on a switch (a failure is logged, not fatal). The login form saves only once Apple accepts the password (signed in, or asked for a code), and passes it to the code form in memory as well. `handleAuthError` deletes it only when the message says the password was rejected ("authentication failed", "invalid credentials", "login failed"), not for a bare `NeedsLoginError`; an expired session arrives as one too. Never word an error the extension makes itself that way, or it deletes a good password.
- 2FA codes → never persisted.
- ipatool's own session lives in macOS Keychain item `ipatool-auth.service` (created/owned by ipatool, not this extension).

The Logout command (`src/logout.ts`) attempts `ipatool auth revoke` then clears LocalStorage and Keychain entries.

### Screenshot Pipeline

`app-store-scraper.ts` extracts screenshots from `<script type="fastboot/shoebox">` JSON → `screenshot-downloader.ts` handles concurrent downloads with `p-limit`, configurable timeouts, and content/size checks → files organized into platform directories. There is **no retry**: a failed file is recorded as failed and the batch continues.

Screenshot hosts are restricted to the whitelist in `config.ts` (`allowedScreenshotDomains`). `config.ts` also reads an optional `allowedScreenshotDomains` **preference** for extra domains — but `package.json` declares no such preference, so that path is currently inert. Either declare it or drop the read; don't document it as a user-facing option.

### Storage

Raycast `LocalStorage` persists favorites, download history, recent searches, the Search command's view mode + platform filter, and the Purchased Apps sort order.

Two caps, and the defaults are not what's in force: `useDownloadHistory(historyLimit = 100)` is used as-is, but `useRecentSearches(limit = 50)` is called by `src/hooks/use-app-search.ts` with **10**, so Search keeps ten.

Keys live in **three** places: `STORAGE_KEYS` in `src/utils/storage.ts` (`recent_searches`, `download_history`, `favorite_apps`, `download_counts`); `src/search.tsx` (`search-view-mode`, `search-platform-entity`); and `src/purchased-apps.tsx` (`purchased-apps-sort`). `src/utils/constants.ts` holds only App Store / iTunes URLs. Most reads and writes go through the hooks, but `search.tsx`, `purchased-apps.tsx`, and `auth.ts` call `LocalStorage` directly.

### External Dependencies

- `ipatool` v2.6.0+ — Homebrew is the easy install, not a requirement: `src/utils/paths.ts` defaults to the Homebrew path for the running architecture, `src/utils/ipatool-validator.ts` also probes `/usr/local/bin`, `/usr/bin` and user-local locations, and the `ipatoolPath` preference accepts any allowed executable path. v2.4.0 is where Apple's commerce auth gate was fixed: PR majd/ipatool#525 replaced App Store auth with SAP-signed requests, closing the HTTP 403 "empty or non-plist body" failures (majd/ipatool#522, #523). **v2.6.0 is the floor as of 2026-09-13**, because Apple's redownload endpoint started answering 2.5.0 with an empty product payload (`Items: []`, surfaced as the bare `invalid response`, majd/ipatool#538) or HTTP 500 with a non-plist body — 2.5.0 can no longer download anything. Verified that day: 2.5.0 failed `com.facebook.hatch` and `com.google.chrome.ios`; 2.6.0 downloaded both. 2.6.0 also writes the download to a sibling `<name>.ipa.tmp` and only assembles the final `.ipa` at the end (it injects iTunes artwork), which the progress poller in `src/ipatool.ts` must match — watching `.ipa` alone reports zero progress for the whole network phase. The version gate accepts any build ≥ 2.6.0.
- `@chrismessina/raycast-logger` — custom logger (`logger.log`, `logger.error`). The convention is to use it instead of `console.*`; several hooks (`use-app-details`, `use-download-history`, `use-recent-searches`) still call `console.error` and should be converted when touched.
- `p-limit` — concurrency control for downloads.
- `lodash` — utility functions.

## Design Docs

In-progress / historical context lives in `docs/`:

- `robust-apple-auth.md` — catalog of crash bugs, 2FA gaps, and ipatool v2.3.0 behaviors the auth code must handle.
- `secure-storage-implementation.md` — secure credential storage details.
- `eslint-9-upgrade-guide.md` — the ESLint 9 flat-config migration.
- `CONFIG.md` — configuration module reference.

**Not on `main`:** `download-manager.md` lives only on branch `feature/download-manager`. It records the failed v1 queue and the constraint that killed it — each Raycast command is a separate process, so a queue cannot rely on shared in-memory state and needs a helper that outlives Raycast ("Tier C"). The build is **shelved**, not in progress: do not start `download-queue-store.ts` / `use-queue-processor.ts`. Downloads may instead move to Coaster (download → diff → report) with this extension as a sender companion.
