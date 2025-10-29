// Storage utilities for managing recent searches, download history, and starred apps
import { LocalStorage } from "@raycast/api";
import type { AppDetails } from "../types";

// =============================================================================
// STORAGE KEYS
// =============================================================================

const STORAGE_KEYS = {
  RECENT_SEARCHES: "recent_searches",
  DOWNLOAD_HISTORY: "download_history",
  STARRED_APPS: "starred_apps",
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

export interface StarredApp {
  app: AppDetails;
  starredDate: string;
}

export interface DownloadCount {
  bundleId: string;
  count: number;
  lastDownloaded: string;
}

// =============================================================================
// RECENT SEARCHES
// =============================================================================

/**
 * Get recent searches from local storage
 * @param limit Maximum number of searches to return
 * @returns Array of recent searches
 */
export async function getRecentSearches(limit = 10): Promise<RecentSearch[]> {
  try {
    const stored = await LocalStorage.getItem<string>(STORAGE_KEYS.RECENT_SEARCHES);
    if (!stored) return [];

    const searches: RecentSearch[] = JSON.parse(stored);
    return searches.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  } catch (error) {
    console.error("Error getting recent searches:", error);
    return [];
  }
}

/**
 * Add a search query to recent searches
 * @param query The search query to add
 */
export async function addRecentSearch(query: string): Promise<void> {
  if (!query || query.trim().length === 0) return;

  try {
    const searches = await getRecentSearches(50); // Get more to check for duplicates

    // Remove existing entry for this query if it exists
    const filteredSearches = searches.filter((search) => search.query !== query.trim());

    // Add new search at the beginning
    const newSearches: RecentSearch[] = [{ query: query.trim(), timestamp: Date.now() }, ...filteredSearches].slice(
      0,
      50,
    ); // Keep only the most recent 50

    await LocalStorage.setItem(STORAGE_KEYS.RECENT_SEARCHES, JSON.stringify(newSearches));
  } catch (error) {
    console.error("Error adding recent search:", error);
  }
}

/**
 * Remove a specific recent search by query
 * @param query The search query to remove
 */
export async function removeRecentSearch(query: string): Promise<void> {
  try {
    const searches = await getRecentSearches(100); // Get all searches
    const filtered = searches.filter((search) => search.query !== query);
    await LocalStorage.setItem(STORAGE_KEYS.RECENT_SEARCHES, JSON.stringify(filtered));
  } catch (error) {
    console.error("Error removing recent search:", error);
  }
}

/**
 * Clear all recent searches
 */
export async function clearRecentSearches(): Promise<void> {
  try {
    await LocalStorage.removeItem(STORAGE_KEYS.RECENT_SEARCHES);
  } catch (error) {
    console.error("Error clearing recent searches:", error);
  }
}

// =============================================================================
// DOWNLOAD HISTORY
// =============================================================================

/**
 * Get download history from local storage
 * @param limit Maximum number of items to return
 * @returns Array of download history items
 */
export async function getDownloadHistory(limit = 50): Promise<DownloadHistoryItem[]> {
  try {
    const stored = await LocalStorage.getItem<string>(STORAGE_KEYS.DOWNLOAD_HISTORY);
    if (!stored) return [];

    const history: DownloadHistoryItem[] = JSON.parse(stored);
    return history
      .sort((a, b) => new Date(b.downloadDate).getTime() - new Date(a.downloadDate).getTime())
      .slice(0, limit);
  } catch (error) {
    console.error("Error getting download history:", error);
    return [];
  }
}

/**
 * Add an app to download history
 * @param app The app that was downloaded
 * @param filePath Optional path where the file was saved
 */
export async function addToDownloadHistory(app: AppDetails, filePath?: string): Promise<void> {
  try {
    const history = await getDownloadHistory(100); // Get more to check for duplicates

    // Remove existing entry for this app if it exists
    const filteredHistory = history.filter((item) => item.app.bundleId !== app.bundleId);

    // Get download count for this app
    const downloadCount = await getDownloadCount(app.bundleId);

    // Add new download at the beginning
    const newHistory: DownloadHistoryItem[] = [
      {
        app,
        downloadDate: new Date().toISOString(),
        downloadCount: downloadCount + 1,
        filePath,
      },
      ...filteredHistory,
    ].slice(0, 100); // Keep only the most recent 100

    await LocalStorage.setItem(STORAGE_KEYS.DOWNLOAD_HISTORY, JSON.stringify(newHistory));

    // Update download count
    await incrementDownloadCount(app.bundleId);
  } catch (error) {
    console.error("Error adding to download history:", error);
  }
}

/**
 * Remove an item from download history
 * @param bundleId The bundle ID of the app to remove
 */
export async function removeFromDownloadHistory(bundleId: string): Promise<void> {
  try {
    const history = await getDownloadHistory(100);
    const filteredHistory = history.filter((item) => item.app.bundleId !== bundleId);
    await LocalStorage.setItem(STORAGE_KEYS.DOWNLOAD_HISTORY, JSON.stringify(filteredHistory));
  } catch (error) {
    console.error("Error removing from download history:", error);
  }
}

/**
 * Clear all download history
 */
export async function clearDownloadHistory(): Promise<void> {
  try {
    await LocalStorage.removeItem(STORAGE_KEYS.DOWNLOAD_HISTORY);
  } catch (error) {
    console.error("Error clearing download history:", error);
  }
}

// =============================================================================
// STARRED APPS
// =============================================================================

/**
 * Get starred apps from local storage
 * @returns Array of starred apps
 */
export async function getStarredApps(): Promise<StarredApp[]> {
  try {
    const stored = await LocalStorage.getItem<string>(STORAGE_KEYS.STARRED_APPS);
    if (!stored) return [];

    const starred: StarredApp[] = JSON.parse(stored);
    return starred.sort((a, b) => new Date(b.starredDate).getTime() - new Date(a.starredDate).getTime());
  } catch (error) {
    console.error("Error getting starred apps:", error);
    return [];
  }
}

/**
 * Check if an app is starred
 * @param bundleId The bundle ID of the app to check
 * @returns True if the app is starred
 */
export async function isAppStarred(bundleId: string): Promise<boolean> {
  try {
    const starredApps = await getStarredApps();
    return starredApps.some((item) => item.app.bundleId === bundleId);
  } catch (error) {
    console.error("Error checking if app is starred:", error);
    return false;
  }
}

/**
 * Add an app to starred apps
 * @param app The app to star
 */
export async function addStarredApp(app: AppDetails): Promise<void> {
  try {
    const starredApps = await getStarredApps();

    // Check if already starred
    if (starredApps.some((item) => item.app.bundleId === app.bundleId)) {
      return;
    }

    const newStarredApps: StarredApp[] = [
      ...starredApps,
      {
        app,
        starredDate: new Date().toISOString(),
      },
    ];

    await LocalStorage.setItem(STORAGE_KEYS.STARRED_APPS, JSON.stringify(newStarredApps));
  } catch (error) {
    console.error("Error adding starred app:", error);
  }
}

/**
 * Remove an app from starred apps
 * @param bundleId The bundle ID of the app to unstar
 */
export async function removeStarredApp(bundleId: string): Promise<void> {
  try {
    const starredApps = await getStarredApps();
    const filteredApps = starredApps.filter((item) => item.app.bundleId !== bundleId);
    await LocalStorage.setItem(STORAGE_KEYS.STARRED_APPS, JSON.stringify(filteredApps));
  } catch (error) {
    console.error("Error removing starred app:", error);
  }
}

/**
 * Clear all starred apps
 */
export async function clearStarredApps(): Promise<void> {
  try {
    await LocalStorage.removeItem(STORAGE_KEYS.STARRED_APPS);
  } catch (error) {
    console.error("Error clearing starred apps:", error);
  }
}

// =============================================================================
// DOWNLOAD COUNTS
// =============================================================================

/**
 * Get download count for an app
 * @param bundleId The bundle ID of the app
 * @returns Number of times the app has been downloaded
 */
export async function getDownloadCount(bundleId: string): Promise<number> {
  try {
    const stored = await LocalStorage.getItem<string>(STORAGE_KEYS.DOWNLOAD_COUNTS);
    if (!stored) return 0;

    const counts: DownloadCount[] = JSON.parse(stored);
    const appCount = counts.find((item) => item.bundleId === bundleId);
    return appCount ? appCount.count : 0;
  } catch (error) {
    console.error("Error getting download count:", error);
    return 0;
  }
}

/**
 * Increment download count for an app
 * @param bundleId The bundle ID of the app
 */
export async function incrementDownloadCount(bundleId: string): Promise<void> {
  try {
    const stored = await LocalStorage.getItem<string>(STORAGE_KEYS.DOWNLOAD_COUNTS);
    const counts: DownloadCount[] = stored ? JSON.parse(stored) : [];

    const existingIndex = counts.findIndex((item) => item.bundleId === bundleId);

    if (existingIndex >= 0) {
      counts[existingIndex].count += 1;
      counts[existingIndex].lastDownloaded = new Date().toISOString();
    } else {
      counts.push({
        bundleId,
        count: 1,
        lastDownloaded: new Date().toISOString(),
      });
    }

    await LocalStorage.setItem(STORAGE_KEYS.DOWNLOAD_COUNTS, JSON.stringify(counts));
  } catch (error) {
    console.error("Error incrementing download count:", error);
  }
}

/**
 * Get all download counts
 * @returns Array of download counts
 */
export async function getAllDownloadCounts(): Promise<DownloadCount[]> {
  try {
    const stored = await LocalStorage.getItem<string>(STORAGE_KEYS.DOWNLOAD_COUNTS);
    if (!stored) return [];

    const counts: DownloadCount[] = JSON.parse(stored);
    return counts.sort((a, b) => b.count - a.count);
  } catch (error) {
    console.error("Error getting all download counts:", error);
    return [];
  }
}

// =============================================================================
// EXPORT UTILITIES
// =============================================================================

/**
 * Export starred apps to markdown format
 * @returns Markdown string of starred apps
 */
export async function exportStarredToMarkdown(): Promise<string> {
  try {
    const starredApps = await getStarredApps();

    if (starredApps.length === 0) {
      return "# No Starred Apps\n\nYou haven't starred any apps yet.";
    }

    let markdown = "# Starred iOS Apps\n\n";
    markdown += `Generated on ${new Date().toLocaleDateString()}\n\n`;

    for (const item of starredApps) {
      const app = item.app;
      markdown += `## ${app.name}\n\n`;
      markdown += `- **Developer:** ${app.sellerName}\n`;
      markdown += `- **Version:** ${app.version}\n`;
      markdown += `- **Price:** ${app.price} ${app.currency}\n`;
      markdown += `- **Bundle ID:** \`${app.bundleId}\`\n`;
      markdown += `- **Starred:** ${new Date(item.starredDate).toLocaleDateString()}\n`;

      if (app.description) {
        const shortDesc = app.description.length > 200 ? app.description.substring(0, 200) + "..." : app.description;
        markdown += `- **Description:** ${shortDesc}\n`;
      }

      markdown += "\n";
    }

    return markdown;
  } catch (error) {
    console.error("Error exporting starred apps to markdown:", error);
    return "# Export Error\n\nFailed to export starred apps.";
  }
}

/**
 * Export starred apps to CSV format
 * @returns CSV string of starred apps
 */
export async function exportStarredToCSV(): Promise<string> {
  try {
    const starredApps = await getStarredApps();

    if (starredApps.length === 0) {
      return "Name,Developer,Version,Price,Currency,Bundle ID,Starred Date\n";
    }

    let csv = "Name,Developer,Version,Price,Currency,Bundle ID,Starred Date\n";

    for (const item of starredApps) {
      const app = item.app;
      const row = [
        `"${app.name.replace(/"/g, '""')}"`, // Escape quotes in CSV
        `"${app.sellerName.replace(/"/g, '""')}"`,
        `"${app.version}"`,
        `"${app.price}"`,
        `"${app.currency}"`,
        `"${app.bundleId}"`,
        `"${new Date(item.starredDate).toLocaleDateString()}"`,
      ];
      csv += row.join(",") + "\n";
    }

    return csv;
  } catch (error) {
    console.error("Error exporting starred apps to CSV:", error);
    return "Error exporting starred apps\n";
  }
}
