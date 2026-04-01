# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Raycast extension for searching, viewing, and downloading iOS apps from the App Store. Uses `ipatool` (CLI) for App Store auth/downloads and the iTunes Search API + App Store web scraping (shoebox JSON) for rich metadata and screenshots.

## Commands

```bash
npm run dev       # Start Raycast development server
npm run build     # Build the extension
npm run lint      # Lint with ray lint
npm run fix-lint  # Auto-fix lint issues
```

## Architecture

### Data Flow

The extension uses a **dual-source approach**:
1. **ipatool** (`src/ipatool.ts`) — wraps the `ipatool` CLI for App Store search, authentication, and IPA downloads. Manages auth state including 2FA.
2. **iTunes API** (`src/utils/itunes-api.ts`) — enriches search results with ratings, icons, screenshots, descriptions via `itunes.apple.com`.
3. **App Store Scraper** (`src/utils/app-store-scraper.ts`) — parses "shoebox JSON" from App Store web pages to extract high-resolution screenshots by platform. Apple may change this structure at any time.

Search results from ipatool are merged with iTunes data in `src/utils/app-search.ts` to produce unified `AppDetails` objects.

### Key Layers

- **Commands** (entry points): `src/search.tsx`, `src/favorites.tsx`, `src/download-history.tsx`, `src/logout.ts`
- **AI Tools**: `src/tools/` — Raycast AI tool handlers (search-apps, get-app-details, download-app, get-current-version, download-app-screenshots)
- **Views**: `src/views/` — app detail view, grid search view
- **Components**: `src/components/` — action panels, copy actions, favorite actions, export actions, auth forms
- **Hooks**: `src/hooks/` (barrel-exported via `index.ts`) — custom React hooks for search, download, favorites, history, auth navigation, clipboard, versions
- **Utils**: `src/utils/` — ipatool validation/auth/error-patterns, iTunes API, App Store scraper, screenshot downloader, icon downloader, temp file management, storage, formatting, paths, constants
- **Config**: `src/config.ts` — runtime config from Raycast preferences with defaults (timeouts, concurrency, integrity verification, allowed domains)
- **Types**: `src/types.ts` — all shared TypeScript interfaces (`AppDetails`, `ITunesResult`, `IpaToolSearchApp`, `PlatformType`, `ScreenshotInfo`, etc.)

### Auth Flow

Authentication goes through `ipatool` with credentials stored in macOS Keychain. The extension provides in-UI forms (`src/components/forms/`) for login and 2FA. Auth state is managed by `src/hooks/use-auth-navigation.tsx` which handles the login/2FA/authenticated flow.

### Screenshot Pipeline

`app-store-scraper.ts` extracts screenshots from shoebox JSON → `screenshot-downloader.ts` handles concurrent downloads with configurable limits (p-limit), timeouts, retries, and integrity verification → files organized by platform directories.

### External Dependencies

- `ipatool` — must be installed via Homebrew; path configurable in preferences
- `@chrismessina/raycast-logger` — custom logging package used throughout (`logger.log`, `logger.error`)
- `adm-zip` — for IPA file inspection
- `p-limit` — concurrency control for screenshot downloads
- `lodash` — utility functions

### Storage

Uses Raycast's `LocalStorage` API for persisting favorites, download history, recent searches, and view mode preferences (`src/utils/storage.ts`).
