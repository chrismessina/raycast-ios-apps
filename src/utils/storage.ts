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

export interface DownloadCount {
  bundleId: string;
  count: number;
  lastDownloaded: string;
}
