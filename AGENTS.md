# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

A Raycast extension for searching, viewing, and downloading iOS apps from the App Store. Uses `ipatool` (CLI, v2.3.0+) for App Store auth/downloads and the iTunes Search API + App Store web scraping (shoebox JSON) for rich metadata and screenshots.

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

The extension uses a **dual-source approach**:

1. **ipatool** (`src/ipatool.ts`) — wraps the `ipatool` CLI for App Store search, authentication, and IPA downloads. Manages auth state including 2FA.
2. **iTunes API** (`src/utils/itunes-api.ts`) — enriches search results with ratings, icons, screenshots, descriptions via `itunes.apple.com`.
3. **App Store Scraper** (`src/utils/app-store-scraper.ts`) — parses "shoebox JSON" from App Store web pages to extract high-resolution screenshots by platform. Apple may change this structure at any time; parsing is designed with multiple fallbacks.

Search results from ipatool are merged with iTunes data in `src/utils/app-search.ts` to produce unified `AppDetails` objects.

### Key Layers

- **Commands** (entry points, declared in `package.json` "commands"): `src/search.tsx`, `src/favorites.tsx`, `src/download-history.tsx`, `src/logout.ts`. Each runs as a **separate Raycast process** with its own module-level state — state is not shared across commands except via `LocalStorage` / Keychain.
- **AI Tools** (declared in `package.json` "tools", evals in `ai.yaml`): `src/tools/` — `search-apps`, `get-app-details`, `download-app`, `get-current-version`, `download-app-screenshots`. AI tools cannot push UI (e.g., login forms); they must surface auth state via return messages.
- **Views**: `src/views/app-detail-view.tsx`, `src/views/grid-search-view.tsx`
- **Components**: `src/components/` — action panels, copy/favorite/export actions, and `forms/` containing `AppleLoginForm` and `AppleTwoFactorForm` for in-UI auth.
- **Hooks**: `src/hooks/` (barrel-exported via `index.ts`) — search, download, favorites, history, auth navigation, clipboard, version data.
- **Utils**: `src/utils/` — ipatool wrappers, iTunes API, App Store scraper, screenshot/icon downloaders, temp file management, storage, formatting, paths, error patterns.
- **Config**: `src/config.ts` — typed runtime config from Raycast preferences with defaults (timeouts, concurrency, integrity verification, allowed screenshot domains).
- **Types**: `src/types.ts` — all shared TypeScript interfaces (`AppDetails`, `ITunesResult`, `IpaToolSearchApp`, `PlatformType`, `ScreenshotInfo`, etc.). Avoid `any`; maintain strict typing per `tsconfig.json`.

### Auth Flow

Two parallel auth implementations exist — be aware of which to use:

- `src/utils/auth.ts` — higher-level auth orchestration, credential storage, `ensureAuthenticated()`, `loginToAppleId()`, `invalidateAuthentication()`. Defines `NeedsLoginError` and `Needs2FAError`.
- `src/utils/ipatool-auth.ts` — async `login()` using `spawn` with real-time 2FA detection from ipatool stdout/stderr. This is the path that correctly catches the case where ipatool exits 0 in non-interactive mode while requiring 2FA.

`src/hooks/use-auth-navigation.tsx` orchestrates the login → 2FA → authenticated UI flow, pushing `AppleLoginForm` / `AppleTwoFactorForm` as needed.

Credential storage:
- Apple ID → `LocalStorage` under key `appleId` (not sensitive).
- Password → Raycast Keychain API under service name `ios-apps-apple-password`.
- 2FA codes → never persisted.
- ipatool's own session lives in macOS Keychain item `ipatool-auth.service` (created/owned by ipatool, not this extension).

The Logout command (`src/logout.ts`) attempts `ipatool auth revoke` then clears LocalStorage and Keychain entries.

### Screenshot Pipeline

`app-store-scraper.ts` extracts screenshots from `<script type="fastboot/shoebox">` JSON → `screenshot-downloader.ts` handles concurrent downloads with `p-limit`, configurable timeouts, retries, and integrity verification → files organized into platform directories. Screenshot host domains are restricted to a whitelist in `config.ts` (`allowedScreenshotDomains`); additional domains can be added via preferences.

### Storage

Raycast `LocalStorage` (`src/utils/storage.ts`) persists favorites, download history (max 100 entries), recent searches, and view mode preferences. Storage keys are centralized in `src/utils/constants.ts`.

### External Dependencies

- `ipatool` v2.3.1+ — Homebrew install required; auto-detected at common paths or set via `ipatoolPath` preference. v2.3.1 is the floor because it restored App Store login after Apple moved the authenticate endpoint (majd/ipatool#507).
- `@chrismessina/raycast-logger` — custom logger (`logger.log`, `logger.error`); use this rather than `console.*`.
- `adm-zip` — IPA file inspection.
- `p-limit` — concurrency control for downloads.
- `lodash` — utility functions.

## Design Docs

In-progress / historical context lives in `docs/`:

- `download-manager.md` — design doc capturing the failed v1 queue implementation and constraints for a v2 attempt. Notably: each Raycast command is a separate process, so a download queue cannot rely on shared in-memory state across commands — it must be `LocalStorage`-backed and tolerate stale entries.
- `robust-apple-auth.md` — catalog of crash bugs, 2FA gaps, and ipatool v2.3.0 behaviors the auth code must handle.
- `secure-storage-implementation.md` — secure credential storage details.
- `CONFIG.md` — configuration module reference.
