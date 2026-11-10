import { useCallback, useEffect, useMemo, useState } from "react";
import { LocalStorage, showToast, Toast } from "@raycast/api";
import type { AppDetails } from "../types";
import { STORAGE_KEYS, withoutCachedITunesData } from "../utils/storage";

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

interface UseDownloadHistoryResult {
  downloadHistory: DownloadHistoryItem[];
  downloadCounts: DownloadCount[];
  addToHistory: (app: AppDetails, filePath?: string) => Promise<void>;
  removeFromHistory: (bundleId: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  getDownloadCount: (bundleId: string) => number;
  refresh: () => Promise<void>;
  isLoading: boolean;
}

// Serializes `appendToDownloadHistory`, so two downloads that finish together
// each read what the other wrote.
let appendChain: Promise<void> = Promise.resolve();

// Mounted history views reload when any write lands, so a download that
// finishes while History is open shows up there.
const historyListeners = new Set<() => void>();

function enqueueHistoryWrite(run: () => Promise<void>): Promise<void> {
  const next = appendChain.then(run, run);
  appendChain = next.catch(() => undefined);
  void next.then(() => historyListeners.forEach((notify) => notify())).catch(() => undefined);
  return next;
}

/**
 * Record a download without a mounted hook's state. The hook's `addToHistory`
 * writes from the arrays it captured at render, so a callback taken at mount
 * (before storage loaded) would replace the saved history with one entry.
 * This reads storage fresh for every write.
 */
export function appendToDownloadHistory(app: AppDetails, filePath?: string, historyLimit = 100): Promise<void> {
  const run = async () => {
    const [historyStored, countsStored] = await Promise.all([
      LocalStorage.getItem<string>(STORAGE_KEYS.DOWNLOAD_HISTORY),
      LocalStorage.getItem<string>(STORAGE_KEYS.DOWNLOAD_COUNTS),
    ]);
    const history: DownloadHistoryItem[] = historyStored ? JSON.parse(historyStored) : [];
    const counts: DownloadCount[] = countsStored ? JSON.parse(countsStored) : [];
    const now = new Date().toISOString();
    const previous = counts.find((item) => item.bundleId === app.bundleId);

    const newHistory: DownloadHistoryItem[] = [
      { app, downloadDate: now, downloadCount: (previous?.count ?? 0) + 1, filePath },
      ...history.filter((item) => item.app.bundleId !== app.bundleId),
    ]
      .slice(0, historyLimit)
      .map((item) => ({ ...item, app: withoutCachedITunesData(item.app) }));
    const newCounts: DownloadCount[] = previous
      ? counts.map((item) =>
          item.bundleId === app.bundleId ? { ...item, count: item.count + 1, lastDownloaded: now } : item,
        )
      : [...counts, { bundleId: app.bundleId, count: 1, lastDownloaded: now }];

    await LocalStorage.setItem(STORAGE_KEYS.DOWNLOAD_HISTORY, JSON.stringify(newHistory));
    await LocalStorage.setItem(STORAGE_KEYS.DOWNLOAD_COUNTS, JSON.stringify(newCounts));
  };
  return enqueueHistoryWrite(run);
}

/**
 * Rewrite the saved history from fresh storage, through the same queue as
 * `appendToDownloadHistory`. A mounted hook's array can be stale (a detached
 * download recorded itself after it loaded), and writing back a filtered copy of
 * that array would erase the newer entry.
 */
function mutateStoredHistory(change: (history: DownloadHistoryItem[]) => DownloadHistoryItem[]): Promise<void> {
  const run = async () => {
    const stored = await LocalStorage.getItem<string>(STORAGE_KEYS.DOWNLOAD_HISTORY);
    const history: DownloadHistoryItem[] = stored ? JSON.parse(stored) : [];
    const next = change(history).map((item) => ({ ...item, app: withoutCachedITunesData(item.app) }));
    await LocalStorage.setItem(STORAGE_KEYS.DOWNLOAD_HISTORY, JSON.stringify(next));
  };
  return enqueueHistoryWrite(run);
}

/** Drop one app's entry. Its download count is kept. */
export function removeFromStoredDownloadHistory(bundleId: string): Promise<void> {
  return mutateStoredHistory((history) => history.filter((item) => item.app.bundleId !== bundleId));
}

/**
 * Replace the app details on an existing entry without touching its date, count
 * or file path, so details fetched after the entry was recorded can be added
 * without counting the download twice.
 */
export function updateStoredDownloadHistoryApp(app: AppDetails): Promise<void> {
  return mutateStoredHistory((history) =>
    history.map((item) => (item.app.bundleId === app.bundleId ? { ...item, app } : item)),
  );
}

/**
 * Hook for managing download history with automatic persistence
 * @param historyLimit Maximum number of history items to keep
 * @returns Object with download history and management functions
 */
export function useDownloadHistory(historyLimit = 100): UseDownloadHistoryResult {
  const [downloadHistory, setDownloadHistory] = useState<DownloadHistoryItem[]>([]);
  const [downloadCounts, setDownloadCounts] = useState<DownloadCount[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Function to load data from LocalStorage
  const loadData = useCallback(async () => {
    try {
      const [historyStored, countsStored] = await Promise.all([
        LocalStorage.getItem<string>(STORAGE_KEYS.DOWNLOAD_HISTORY),
        LocalStorage.getItem<string>(STORAGE_KEYS.DOWNLOAD_COUNTS),
      ]);

      if (historyStored) {
        const history: DownloadHistoryItem[] = JSON.parse(historyStored);
        setDownloadHistory(history.map((item) => ({ ...item, app: withoutCachedITunesData(item.app) })));
      }

      if (countsStored) {
        const counts: DownloadCount[] = JSON.parse(countsStored);
        setDownloadCounts(counts);
      }
    } catch (error) {
      console.error("Error loading download data:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load download history and counts on mount
  useEffect(() => {
    loadData();
    historyListeners.add(loadData);
    return () => {
      historyListeners.delete(loadData);
    };
  }, [loadData]);

  /**
   * Get download count for an app
   */
  const getDownloadCount = useCallback(
    (bundleId: string): number => {
      const appCount = downloadCounts.find((item) => item.bundleId === bundleId);
      return appCount ? appCount.count : 0;
    },
    [downloadCounts],
  );

  /**
   * Add an app to download history
   */
  const addToHistory = useCallback(
    async (app: AppDetails, filePath?: string) => {
      try {
        // Read storage fresh rather than the arrays captured at render: a
        // download runs for minutes, and a detached one that finished in the
        // meantime would otherwise be overwritten by this stale snapshot.
        await appendToDownloadHistory(app, filePath, historyLimit);
        await loadData();
      } catch (error) {
        console.error("Error adding to download history:", error);
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to Save History",
          message: "Could not add to download history",
        });
      }
    },
    [loadData, historyLimit],
  );

  /**
   * Remove an item from download history
   */
  const removeFromHistory = useCallback(
    async (bundleId: string) => {
      try {
        await removeFromStoredDownloadHistory(bundleId);
        await loadData();
        await showToast({
          style: Toast.Style.Success,
          title: "Removed from History",
          message: "App has been removed from download history",
        });
      } catch (error) {
        console.error("Error removing from download history:", error);
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to Remove",
          message: "Could not remove from download history",
        });
      }
    },
    [loadData],
  );

  /**
   * Clear all download history
   */
  const clearHistory = useCallback(async () => {
    try {
      await LocalStorage.removeItem(STORAGE_KEYS.DOWNLOAD_HISTORY);
      setDownloadHistory([]);
      await showToast({
        style: Toast.Style.Success,
        title: "History Cleared",
        message: "Download history has been cleared",
      });
    } catch (error) {
      console.error("Error clearing download history:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Clear History",
        message: "Could not clear download history",
      });
    }
  }, []);

  // Memoize sorted and sliced arrays to prevent infinite loops
  const sortedHistory = useMemo(
    () =>
      downloadHistory
        .sort((a, b) => new Date(b.downloadDate).getTime() - new Date(a.downloadDate).getTime())
        .slice(0, historyLimit),
    [downloadHistory, historyLimit],
  );

  const sortedCounts = useMemo(() => downloadCounts.sort((a, b) => b.count - a.count), [downloadCounts]);

  return {
    downloadHistory: sortedHistory,
    downloadCounts: sortedCounts,
    addToHistory,
    removeFromHistory,
    clearHistory,
    getDownloadCount,
    refresh: loadData,
    isLoading,
  };
}
