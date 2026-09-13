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

There is no test setup — running a single test is not applicable. The `ray` CLI must be on PATH.

## Architecture

### Data Flow

Three sources, and **which one searches depends on the caller**:

1. **ipatool** (`src/ipatool.ts`) — wraps the `ipatool` CLI for authentication, IPA downloads, purchases, and `searchApps()`. Manages auth state including 2FA.
2. **iTunes API** (`src/utils/itunes-api.ts`) — ratings, icons, screenshots, descriptions via `itunes.apple.com`.
3. **App Store Scraper** (`src/utils/app-store-scraper.ts`) — parses the `serialized-server-data` JSON blob out of App Store web pages for high-resolution screenshots by platform. (The exported helper is still named `extractScreenshotsFromShoeboxJson` and the prose in that file still says "shoebox" in places — shoebox is the structure Apple deprecated in the 2024 redesign, and the parser has not targeted it since.) Apple may change this at any time; parsing is designed to fail gracefully.

The **Search command** does not use ipatool at all: `src/hooks/use-app-search.ts` queries iTunes (lookup by ID/bundle ID/URL, falling back to term search) and maps results straight to `AppDetails`. The **AI tools** are the ipatool search path — `src/tools/search-apps.ts` calls `searchApps()` and enriches each hit via `enrichAppDetails()`.

`src/utils/app-search.ts` merges nothing; it is pure matching and ranking helpers (`filterRelevantApps`, `scoreAndSortIpaToolApps`, `getBestIpaToolMatch`, …) used by both paths.

### Key Layers

- **Commands** (entry points, declared in `package.json` "commands"): `src/search.tsx`, `src/favorites.tsx`, `src/purchased-apps.tsx`, `src/download-history.tsx`, `src/logout.ts`. Each runs as a **separate Raycast process** with its own module-level state — nothing in memory is shared. What IS shared: `LocalStorage`, the Keychain, and the downloads directory on disk.
- **AI Tools** (declared in `package.json` "tools", evals in `ai.yaml`): `src/tools/` — `search-apps`, `get-app-details`, `download-app`, `get-current-version`, `download-app-screenshots`. AI tools can show toasts and HUDs, but cannot push a **view** — there is no navigation stack, so a login form is impossible. They must surface auth state via return messages.
- **Views**: `src/views/app-detail-view.tsx`, `src/views/grid-search-view.tsx`, `src/views/developer-apps-view.tsx`
- **Components**: `src/components/` — action panels, copy/favorite/export actions, and `forms/` containing `AppleLoginForm` and `AppleTwoFactorForm` for in-UI auth.
- **Hooks**: `src/hooks/` — search, download, details, screenshots, favorites, history, purchased apps, recent searches, auth navigation, clipboard, version data. `index.ts` is a barrel for most of them, but **not** `use-auth-navigation` or `use-app-screenshots`; import those by path.
- **Utils**: `src/utils/` — ipatool wrappers, iTunes API, App Store scraper, screenshot/icon downloaders, temp file management, storage, formatting, paths, error patterns.
- **Config**: `src/config.ts` — typed runtime config from Raycast preferences with defaults: download timeout, stall timeout, temp cleanup on exit, integrity verification, allowed screenshot domains. It does **not** own concurrency — the screenshot downloader reads its own limit from preferences directly.
- **Types**: `src/types.ts` — all shared TypeScript interfaces (`AppDetails`, `ITunesResult`, `IpaToolSearchApp`, `PlatformType`, `ScreenshotInfo`, etc.). Avoid `any`; maintain strict typing per `tsconfig.json`.

### Auth Flow

Two parallel auth implementations exist — be aware of which to use:

- `src/utils/errors.ts` — all typed error classes: `NeedsLoginError`, `Needs2FAError`, `NotYetReleasedError`, `BuiltInAppError`, `AppleAuthGateError`, `AppleEmptyResponseError`. **This module must import nothing.** It is the leaf that keeps the graph acyclic: today `auth.ts → ipatool-auth.ts → errors.ts` and `auth.ts → errors.ts`, with `ipatool-auth.ts` no longer importing `auth.ts`. The cycle it was extracted to break was `auth.ts → ipatool-auth.ts → auth.ts`; adding an import here can reintroduce one. `auth.ts` re-exports these for compatibility.
- `src/utils/auth.ts` — higher-level auth orchestration, credential storage, `ensureAuthenticated()`, `loginToAppleId()`, `invalidateAuthentication()`. Also holds the 30s auth cache (`clearAuthenticationCache()`, `authGeneration`); `clearStoredCredentials()` must invalidate **before** its first `await`.
- `src/utils/ipatool-auth.ts` — async `login()` using `spawn`, detecting a 2FA prompt in real time from **stdout** (stderr is accumulated and inspected at process close). This is the path that correctly catches the case where ipatool exits 0 in non-interactive mode while requiring 2FA.

`src/hooks/use-auth-navigation.tsx` orchestrates the login → 2FA → authenticated UI flow, pushing `AppleLoginForm` / `AppleTwoFactorForm` as needed.

Credential storage:

- Apple ID → `LocalStorage` under key `appleId` (not sensitive).
- Password → Raycast Keychain API under service name `ios-apps-apple-password`.
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
