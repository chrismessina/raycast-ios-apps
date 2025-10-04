# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

Repository scope
- This repo is a standalone Raycast extension (TypeScript + React) at the repository root.
- All development tasks (install, dev, build, lint, publish) run from the repo root.

Commonly used commands
- Prerequisites
  - Raycast app installed on macOS
  - Raycast CLI available on PATH (ray --version)
  - Node.js and npm installed
- Quickstart (from repository root)
  - Install dependencies (clean CI install preferred)
    ```bash path=null start=null
    npm ci
    # or
    npm install
    ```
  - Start development (opens Raycast build in dev mode)
    ```bash path=null start=null
    npm run dev
    ```
  - Lint and fix
    ```bash path=null start=null
    npm run lint
    npm run fix-lint
    ```
  - Build the extension
    ```bash path=null start=null
    npm run build
    ```
  - Run Raycast AI evals (scenarios live in ai.yaml)
    ```bash path=null start=null
    npm run evals
    ```
  - Publish to the Raycast Store
    ```bash path=null start=null
    npm run publish
    ```
- Notes
  - There is no test setup or test scripts; running a single test is not applicable.
  - The scripts above are defined in package.json and invoke the Raycast CLI under the hood (ray develop, ray build, ray lint, etc.).

High-level architecture and structure
- Extension manifest and preferences
  - package.json declares the Raycast extension ("$schema": https://www.raycast.com/schemas/extension.json), commands, tools, and user preferences (e.g., downloadPath, ipatoolPath, concurrency/timeouts, platform toggles, verbosity).
  - Preferences are read via Raycast APIs at runtime and influence UI and behavior.
- Source organization (src)
  - Commands (src/search.tsx, src/logout.ts, src/app-detail-view.tsx)
    - User-facing Raycast commands that orchestrate flows: searching, viewing app details, and logging out/clearing stored credentials.
  - Components (src/components/*)
    - Reusable UI elements and action panels; forms/ contains AppleLoginForm and AppleTwoFactorForm for in-UI authentication flows.
  - Hooks (src/hooks/*)
    - Encapsulate data fetching and side effects: app search, details, downloads, screenshots, clipboard helpers, and auth navigation.
  - Utils (src/utils/*)
    - ipatool.ts and ipatool-auth.ts bridge to the ipatool CLI, handle invocation, parse output, and manage auth/revoke flows.
    - itunes-api.ts fetches enriched app metadata from Apple’s iTunes endpoints.
    - app-store-scraper.ts parses Apple’s shoebox JSON for high‑resolution screenshots with resilient fallbacks.
    - screenshot-downloader.ts coordinates concurrent image downloads (p-limit), progress, retries, and integrity checks.
    - config.ts reads preferences and exposes a typed configuration surface (timeouts, integrity verification, cleanup behavior, etc.).
    - logger.ts and error-handler.ts centralize logging and error normalization.
    - paths.ts, temp-file-manager.ts, and related helpers manage filesystem paths and temporary artifacts.
  - Types (src/types.ts)
    - Shared TypeScript types for consistent data modeling across commands, hooks, and utils.
- Raycast AI tools and evals
  - Tools are implemented in src/tools/*.ts (e.g., search-apps, get-app-details, get-current-version, download-app, download-app-screenshots) and correspond to entries in package.json "tools".
  - Evaluation scenarios and guidance for AI tools live in ai.yaml (not in package.json).
- Security and storage
  - See docs/secure-storage-implementation.md. Credentials are handled with Raycast’s secure storage APIs and macOS Keychain; Apple ID is kept in LocalStorage, passwords in Keychain, and 2FA codes are never persisted. The Logout command revokes where possible and clears stored credentials.

Important usage notes (from the extension’s README)
- Requirements
  - Homebrew must be installed.
  - Install ipatool via Homebrew before using download/auth features:
    ```bash path=null start=null
    brew install ipatool
    ```
  - The extension auto-detects ipatool in common locations; you can override the path in preferences if needed.
- Authentication
  - ipatool handles Apple ID authentication. Initial actions may prompt for login and 2FA; the extension provides in-UI forms for a streamlined flow.
  - macOS may prompt on first access to Keychain items used by ipatool; the README documents how to reduce prompts via Keychain Access.
- Downloads
  - By default, assets are saved under ~/Downloads (configurable via the Download Path preference). Screenshots are saved at highest resolution and downloads are platform‑filterable via preferences.

Raycast project rules and conventions
- Raycast CLI (ray) must be available on PATH.
- Avoid any in TypeScript; maintain strict typing consistent with tsconfig.
- Raycast AI evals are stored in ai.yaml, not in package.json.
