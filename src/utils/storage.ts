// Storage type definitions and constants
//
// All storage operations are handled by React hooks:
// - useFavoriteApps() - Favorite apps management
// - useRecentSearches() - Recent searches management
// - useDownloadHistory() - Download history and counts management
//
// This file only contains shared types and storage keys.
//
import type { AppDetails } from "../types";

// =============================================================================
// STORAGE KEYS
// =============================================================================

export const STORAGE_KEYS = {
  RECENT_SEARCHES: "recent_searches",
  DOWNLOAD_HISTORY: "download_history",
  FAVORITE_APPS: "favorite_apps",
  DOWNLOAD_COUNTS: "download_counts",
} as const;

// =============================================================================
// TYPES
// =============================================================================

export interface RecentSearch {
  query: string;
  timestamp: number;
}

export interface DownloadHistoryItem {
  app: AppDetails;
  downloadDate: string;
  downloadCount: number;
  filePath?: string;
}

/**
 * Drop the legacy `itunesData` blob from a previously-persisted app.
 *
 * AppDetails used to carry the whole unparsed iTunes record next to the fields
 * already flattened out of it. Nothing read it, so the field is gone from the
 * type — but entries written before that still hold it on disk and `JSON.parse`
 * returns it regardless. Applied on read and on write, because a Raycast
 * command gets a 100 MB JS heap and holds the parsed array for the view's life.
 *
 * @param app An app loaded from LocalStorage
 * @returns The same app without the legacy payload
 */
export function withoutCachedITunesData(app: AppDetails): AppDetails {
  if (!("itunesData" in app)) {
    return app;
  }
  const slim: AppDetails & { itunesData?: unknown } = { ...app };
  delete slim.itunesData;
  return slim;
}

export interface DownloadCount {
  bundleId: string;
  count: number;
  lastDownloaded: string;
}
