import { useCallback, useState, useEffect, useMemo } from "react";
import { showToast, Toast, LocalStorage } from "@raycast/api";
import { STORAGE_KEYS } from "../utils/storage";
import type { AppDetails } from "../types";

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
  isLoading: boolean;
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

  // Load download history and counts on mount
  useEffect(() => {
    async function loadData() {
      try {
        const [historyStored, countsStored] = await Promise.all([
          LocalStorage.getItem<string>(STORAGE_KEYS.DOWNLOAD_HISTORY),
          LocalStorage.getItem<string>(STORAGE_KEYS.DOWNLOAD_COUNTS),
        ]);

        if (historyStored) {
          const history: DownloadHistoryItem[] = JSON.parse(historyStored);
          setDownloadHistory(history);
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
    }
    loadData();
  }, []);

  // Persist history to LocalStorage
  const persistHistory = useCallback(async (history: DownloadHistoryItem[]) => {
    try {
      await LocalStorage.setItem(STORAGE_KEYS.DOWNLOAD_HISTORY, JSON.stringify(history));
      setDownloadHistory(history);
    } catch (error) {
      console.error("Error persisting download history:", error);
      throw error;
    }
  }, []);

  // Persist counts to LocalStorage
  const persistCounts = useCallback(async (counts: DownloadCount[]) => {
    try {
      await LocalStorage.setItem(STORAGE_KEYS.DOWNLOAD_COUNTS, JSON.stringify(counts));
      setDownloadCounts(counts);
    } catch (error) {
      console.error("Error persisting download counts:", error);
      throw error;
    }
  }, []);

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
   * Increment download count for an app
   */
  const incrementDownloadCount = useCallback(
    async (bundleId: string) => {
      const existingIndex = downloadCounts.findIndex((item) => item.bundleId === bundleId);

      let newCounts: DownloadCount[];
      if (existingIndex >= 0) {
        newCounts = [...downloadCounts];
        newCounts[existingIndex] = {
          ...newCounts[existingIndex],
          count: newCounts[existingIndex].count + 1,
          lastDownloaded: new Date().toISOString(),
        };
      } else {
        newCounts = [
          ...downloadCounts,
          {
            bundleId,
            count: 1,
            lastDownloaded: new Date().toISOString(),
          },
        ];
      }

      await persistCounts(newCounts);
    },
    [downloadCounts, persistCounts],
  );

  /**
   * Add an app to download history
   */
  const addToHistory = useCallback(
    async (app: AppDetails, filePath?: string) => {
      try {
        // Remove existing entry for this app if it exists
        const filteredHistory = downloadHistory.filter((item) => item.app.bundleId !== app.bundleId);

        // Get current download count
        const currentCount = getDownloadCount(app.bundleId);

        // Add new download at the beginning
        const newHistory: DownloadHistoryItem[] = [
          {
            app,
            downloadDate: new Date().toISOString(),
            downloadCount: currentCount + 1,
            filePath,
          },
          ...filteredHistory,
        ].slice(0, historyLimit);

        await persistHistory(newHistory);

        // Update download count
        await incrementDownloadCount(app.bundleId);
      } catch (error) {
        console.error("Error adding to download history:", error);
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to Save History",
          message: "Could not add to download history",
        });
      }
    },
    [downloadHistory, persistHistory, getDownloadCount, incrementDownloadCount, historyLimit],
  );

  /**
   * Remove an item from download history
   */
  const removeFromHistory = useCallback(
    async (bundleId: string) => {
      try {
        const filtered = downloadHistory.filter((item) => item.app.bundleId !== bundleId);
        await persistHistory(filtered);
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
    [downloadHistory, persistHistory],
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
    isLoading,
  };
}
