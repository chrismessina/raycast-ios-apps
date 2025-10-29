import { useCallback, useState, useEffect } from "react";
import { showToast, Toast, LocalStorage } from "@raycast/api";
import { STORAGE_KEYS, type RecentSearch } from "../utils/storage";

// Re-export for convenience
export type { RecentSearch };

interface UseRecentSearchesResult {
  recentSearches: RecentSearch[];
  addRecentSearch: (query: string) => Promise<void>;
  removeRecentSearch: (query: string) => Promise<void>;
  clearRecentSearches: () => Promise<void>;
  isLoading: boolean;
}

/**
 * Hook for managing recent searches with automatic persistence
 * @param limit Maximum number of recent searches to keep
 * @returns Object with recent searches and management functions
 */
export function useRecentSearches(limit = 50): UseRecentSearchesResult {
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Load recent searches on mount
  useEffect(() => {
    async function loadSearches() {
      try {
        const stored = await LocalStorage.getItem<string>(STORAGE_KEYS.RECENT_SEARCHES);
        if (stored) {
          const searches: RecentSearch[] = JSON.parse(stored);
          setRecentSearches(searches);
        }
      } catch (error) {
        console.error("Error loading recent searches:", error);
      } finally {
        setIsLoading(false);
      }
    }
    loadSearches();
  }, []);

  // Persist to LocalStorage whenever recentSearches changes
  const persistSearches = useCallback(async (searches: RecentSearch[]) => {
    try {
      await LocalStorage.setItem(STORAGE_KEYS.RECENT_SEARCHES, JSON.stringify(searches));
      setRecentSearches(searches);
    } catch (error) {
      console.error("Error persisting recent searches:", error);
      throw error;
    }
  }, []);

  /**
   * Add a search query to recent searches
   */
  const addRecentSearch = useCallback(
    async (query: string) => {
      if (!query || query.trim().length === 0) return;

      try {
        const trimmedQuery = query.trim();

        // Load current searches from storage to ensure we have the latest
        const stored = await LocalStorage.getItem<string>(STORAGE_KEYS.RECENT_SEARCHES);
        const currentSearches: RecentSearch[] = stored ? JSON.parse(stored) : [];

        // Remove existing entry for this query if it exists
        const filteredSearches = currentSearches.filter((search) => search.query !== trimmedQuery);

        // Add new search at the beginning and limit to specified number
        const newSearches: RecentSearch[] = [{ query: trimmedQuery, timestamp: Date.now() }, ...filteredSearches].slice(
          0,
          limit,
        );

        await persistSearches(newSearches);
      } catch (error) {
        console.error("Error adding recent search:", error);
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to Save Search",
          message: "Could not add to recent searches",
        });
      }
    },
    [recentSearches, persistSearches, limit],
  );

  /**
   * Remove a specific recent search by query
   */
  const removeRecentSearch = useCallback(
    async (query: string) => {
      try {
        const filtered = recentSearches.filter((search) => search.query !== query);
        await persistSearches(filtered);
        await showToast({
          style: Toast.Style.Success,
          title: "Search Removed",
          message: `"${query}" removed from recent searches`,
        });
      } catch (error) {
        console.error("Error removing recent search:", error);
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to Remove Search",
          message: "Could not remove recent search",
        });
      }
    },
    [recentSearches, persistSearches],
  );

  /**
   * Clear all recent searches
   */
  const clearRecentSearches = useCallback(async () => {
    try {
      await LocalStorage.removeItem(STORAGE_KEYS.RECENT_SEARCHES);
      setRecentSearches([]);
      await showToast({
        style: Toast.Style.Success,
        title: "Recent Searches Cleared",
        message: "Your search history has been cleared",
      });
    } catch (error) {
      console.error("Error clearing recent searches:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Clear Searches",
        message: "Could not clear recent searches",
      });
    }
  }, []);

  return {
    recentSearches: recentSearches.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit),
    addRecentSearch,
    removeRecentSearch,
    clearRecentSearches,
    isLoading,
  };
}
