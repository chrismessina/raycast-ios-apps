# Download Manager: Design Document

Written for a coding agent. Captures what was tried, what failed, why, and what the next attempt should account for.

---

## Goal

Replace the extension's one-at-a-time, fire-and-forget download model with a queue-based download manager. Users should be able to trigger multiple downloads from any view (Search, Favorites, Downloads) and have them execute sequentially, with visibility into queue state, retry for failures, and proper auth handling.

---

## What Was Tried (v1 — failed)

### Architecture

- **`useDownloadQueue` hook** (`src/hooks/use-download-queue.ts`) — new React hook managing queue state via `useState` + `LocalStorage` persistence. FIFO processing loop in a `useEffect`.
- **`useAppDownload` refactored** to delegate to `useDownloadQueue().enqueue()` instead of calling `downloadApp()` directly. Removed the `globalDownloadState` mutex.
- **Download History view** renamed to "Downloads" with status filter dropdown (All/Queued/Incomplete/Finished) and sections for Downloading, Queued, Failed, Available Updates, Downloaded.
- **Queue persistence** in `LocalStorage` under `STORAGE_KEYS.DOWNLOAD_QUEUE`.

### What Worked

- Enqueuing from any view (toast with queue position)
- Sequential FIFO processing with module-level `processingLock`
- Version extraction from downloaded filenames
- Auth flow integration (NeedsLoginError/Needs2FAError pausing the queue)
- Failed/retry state tracking
- `.ipa.tmp` cleanup before downloads (prevents "negative offset" errors)

### What Failed and Why

#### 1. Multiple hook instances with independent React state

**The core architectural failure.** Every component that calls `useAppDownload()` creates its own `useDownloadQueue()` instance, each with independent `useState`. The Search view, Favorites view, Download History view, AppActions component, and AppDetailView all instantiate separate hook instances.

When instance A enqueues an item and calls `persistQueue()`, it updates:
- `LocalStorage` (shared) ✓
- Instance A's `queueItems` state ✓
- Instance B's `queueItems` state ✗ — B still has stale state from its mount

**Consequences:**
- Downloads view showed empty queue because its hook instance never saw items enqueued by the Search view's instance
- The processing `useEffect` in instance B never fired for items enqueued by instance A
- Multiple instances could race to call `processNext()` before the `processingLock` was set (async gap between `useEffect` firing and the lock being acquired)

#### 2. Concurrent download spawning (race condition)

The initial implementation used `useRef(false)` as a processing lock. Multiple `useEffect` triggers could invoke `processNext()` before the first one's `await` yielded and set the ref. This caused the same app to download 4+ times simultaneously, corrupting temp files and stalling downloads.

**Mitigation attempted:** Module-level `let processingLock = false` (synchronous, checked before any await). This fixed the concurrent spawning but didn't fix the state isolation problem.

#### 3. Raycast `searchBarAccessory` only supports one element

The Downloads view tried to render two `List.Dropdown` elements in a JSX fragment. Raycast silently dropped the first one (status filter), only showing the second (sort). Users could never access the status filter.

**Mitigation attempted:** Combined both into a single dropdown with sections and prefixed values (`status:queued`, `sort:recent`). Required a `value` prop for controlled behavior. Still had issues with the loading state when selecting queue-only filters.

#### 4. `isLoading` gated on history hook, not just queue

When filtering to "Queued" or "Incomplete", the `isLoading` state included `isHistoryLoading` (which fetches version info from iTunes API). The empty view never rendered because `isLoading` was true while waiting for unrelated history data.

#### 5. Downloads processing wrong item / stale queue

When a user clicked "Download Again" on app B, the queue still had a stale item for app A from a previous session. The queue processed FIFO, so app A downloaded instead of app B. Users had no way to see or clear the stale queue (see problem #1 — queue sections were invisible).

---

## Raycast Platform Constraints

These are non-obvious behaviors that any implementation must account for.

### Separate processes per command

Each Raycast command (`search`, `favorites`, `download-history`, `logout`) runs as a **separate process** with its own module-level state. `globalDownloadState` in one command is invisible to another.

```
Command A (Search)           Command B (Downloads)
├─ module-level state        ├─ module-level state
│  (independent)             │  (independent)
└─ LocalStorage (shared) ────┴─ LocalStorage (shared)
```

**Implication:** Module-level locks do NOT prevent concurrent downloads across commands. Only `LocalStorage` is shared.

### React hooks create independent state per instance

Every `useMyHook()` call creates its own `useState`, even within the same process. A hook used in both a parent component and a child component has TWO independent state containers. `persistQueue()` updating `setQueueItems` in one instance does not update the other.

### `searchBarAccessory` accepts exactly one element

Not a fragment, not multiple children. One `List.Dropdown`. To combine filter + sort, use a single dropdown with `List.Dropdown.Section` groups.

### `List.isLoading` blocks `EmptyView`

If `isLoading` is `true`, Raycast shows a spinner and suppresses `List.EmptyView`. When the visible content is empty because of a filter (not because data hasn't loaded), `isLoading` must be `false`.

### `showToast` vs `showHUD`

- `showToast` — works in `view` mode commands. Supports actions, progress updates, style changes.
- `showHUD` — works in `no-view` mode commands. Simple text overlay.
- Toast actions can use `launchCommand()` to navigate to another command.

### `no-view` commands can't render React

The `logout` command uses `showHUD`, not `showToast`. It cannot render forms or lists.

### `LocalStorage` is async and not reactive

`LocalStorage.getItem()` is async. There is no subscription/watch mechanism. To detect changes made by another process, you must poll or re-read on mount.

---

## Recommended Architecture for v2

### Principle: Separate data layer from React hooks

The v1 failure was caused by coupling queue state management to React hook lifecycle. The queue should be a **storage-backed singleton service**, not a React hook with `useState`.

### Storage layer: `LocalStorage` as the single source of truth

```typescript
// src/utils/download-queue-store.ts — plain async functions, no React
async function readQueue(): Promise<DownloadQueueItem[]>
async function writeQueue(items: DownloadQueueItem[]): Promise<void>
async function enqueue(item: Omit<DownloadQueueItem, 'id' | 'addedAt' | 'status' | 'retryCount'>): Promise<DownloadQueueItem>
async function updateItemStatus(id: string, status: DownloadQueueItemStatus, extra?: Partial<DownloadQueueItem>): Promise<void>
async function removeItem(id: string): Promise<void>
async function getNextQueued(): Promise<DownloadQueueItem | null>
```

No React state. No hooks. Just `LocalStorage` read/write. This eliminates the multi-instance problem entirely.

### Processing: Module-level processor in a dedicated hook

```typescript
// src/hooks/use-queue-processor.ts
// ONE hook instance per command that owns processing.
// Only the Downloads command should run this hook.
// Other commands (Search, Favorites) only call enqueue() from the store.
export function useQueueProcessor(authNavigation: AuthNavigationHelpers) {
  // Poll queue store on interval (e.g., every 1-2s) to pick up new items
  // Module-level lock prevents concurrent processing
  // Handles auth flow via authNavigation
}
```

### UI: Read-only hook for rendering queue state

```typescript
// src/hooks/use-queue-view.ts
// Reads from LocalStorage, provides reactive state for rendering.
// Does NOT process downloads.
export function useQueueView() {
  const [items, setItems] = useState<DownloadQueueItem[]>([]);
  // Poll or re-read on interval to stay fresh
  return { items, isLoading };
}
```

### Enqueuing: Direct store call, no hook needed

```typescript
// In any action handler (Search, Favorites, Download History):
import { enqueue } from "../utils/download-queue-store";
await enqueue({ app, bundleId, name, version, price });
await showToast({ ... });
```

No `useDownloadQueue()` hook. No React state. Just write to storage and show a toast.

### Downloads command: Combines queue view + processor + history

```typescript
// src/download-history.tsx
export default function Downloads() {
  const processor = useQueueProcessor(authNavigation);  // owns processing
  const { items: queueItems } = useQueueView();         // reads queue for display
  const { downloadHistory, ... } = useDownloadHistory(); // existing history
  // Render sections: Downloading, Queued, Failed, Updates, Downloaded
}
```

Only the Downloads command runs the processor. If no Downloads command is open, enqueued items sit in storage until it is opened. This is a deliberate simplification — downloads don't happen in the background.

### Alternative: Process downloads in the enqueuing command

If downloads should start immediately from Search/Favorites (not just when Downloads is open), the processor can live in `useAppDownload`. But it must be a **read-from-storage loop**, not a React state-driven `useEffect`. The loop reads `LocalStorage`, checks for queued items, processes one, writes result back to `LocalStorage`. Other hook instances never need to share React state — they just read storage independently.

---

## Feature Requirements

### Queue management
- Enqueue from any view (Search, Favorites, Downloads, App Detail)
- FIFO sequential processing (one download at a time)
- Duplicate detection (same bundleId already queued/downloading)
- Queue position feedback via toast ("Queued #3")
- Cancel queued items
- Retry failed items
- Clear completed/failed items
- Stale item cleanup (items stuck in "downloading" on app restart → reset to "queued")

### Downloads view
- Single dropdown with Filter section (All/Queued/Incomplete/Finished) and Sort section
- Sections: Downloading (blue tag), Queued (orange, position #), Failed (red, error subtitle), Available Updates (green), Downloaded
- Apps in queue excluded from history sections to avoid duplicates
- `isLoading` gated per filter (queue filters don't wait for history/version loading)
- Empty view with contextual message per filter

### Version handling
- ipatool always downloads latest version regardless of version param
- Parse actual version from downloaded filename: `bundleId_adamId_version.ipa`
- Store actual version in history so "Update Available" is accurate
- "Download Again" should pass latest known version (from iTunes API) for file naming

### Auth integration
- Queue pauses on `NeedsLoginError` / `Needs2FAError`
- Auth forms pushed inline via `authNavigation`
- After auth success, queue resumes from the paused item
- Works within the command that's processing (not cross-process)

### Download toast
- Animated progress toast with percentage
- Primary action: "View Downloads" (launches download-history command)
- Success toast with "Show in Finder" / "Copy to Clipboard" actions
- Failure toast with error message

### History preservation
- Download counts (`incrementDownloadCount`) only on successful completion
- `addToHistory(app, filePath)` with actual downloaded version
- History limit: 100 items
- Existing sort/filter/favorites functionality unchanged

---

## Files to Create / Modify

### New files
- `src/utils/download-queue-store.ts` — storage-backed queue CRUD (no React)
- `src/hooks/use-queue-processor.ts` — processing loop hook (one instance)
- `src/hooks/use-queue-view.ts` — read-only queue state for rendering

### Modified files
- `src/hooks/use-app-download.ts` — call `enqueue()` from store instead of `downloadApp()` directly; keep existing `globalDownloadState` as fallback for non-queued direct downloads
- `src/download-history.tsx` — add queue sections, combined filter/sort dropdown
- `src/utils/storage.ts` — add `DOWNLOAD_QUEUE` key and `DownloadQueueItem` types
- `src/hooks/index.ts` — export new hooks
- `package.json` — rename command title to "Downloads"

### Unchanged files
- `src/ipatool.ts` — `downloadApp()` remains the low-level download function
- `src/hooks/use-download-history.ts` — history hook unchanged
- `src/search.tsx`, `src/favorites.tsx` — only change is calling `enqueue()` via `useAppDownload`

---

## Testing Checklist

1. Single download from Search → enqueues, downloads, appears in history
2. Multiple rapid downloads from Favorites → queued sequentially, correct FIFO order
3. Open Downloads view → queue sections visible with correct status tags
4. Filter to "Queued" with empty queue → shows empty view immediately (no spinner)
5. Filter to "Queued" with items → shows items, no spinner
6. Cancel a queued item → removed from queue, next item processes
7. Retry a failed item → resets to queued, processes when turn comes
8. Download requiring auth → login/2FA form inline, resumes after
9. Close Raycast mid-download → on reopen, "downloading" item reset to "queued"
10. Download from Search, open Downloads → queue items visible (storage-backed, not hook-state-backed)
11. "Download Again" on history item → enqueues with latest version
12. Completed download → correct version in history, download count incremented
13. App in queue AND in history → only shown in queue section, not duplicated in history section
