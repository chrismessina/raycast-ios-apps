import { useCallback, useEffect, useState } from "react";
import { showToast, Toast } from "@raycast/api";
import { debounce } from "lodash";
import type { AppDetails } from "../types";
import { searchITunesApps, convertITunesResultToAppDetails } from "../utils/itunes-api";
import {
  getRecentSearches,
  addRecentSearch,
  clearRecentSearches,
  removeRecentSearch,
  type RecentSearch,
} from "../utils/storage";

interface UseAppSearchResult {
  apps: AppDetails[];
  isLoading: boolean;
  error: string | null;
  totalResults: number;
  searchText: string;
  setSearchText: (text: string) => void;
  recentSearches: RecentSearch[];
  clearRecentSearches: () => Promise<void>;
  removeRecentSearch: (query: string) => Promise<void>;
}

/**
 * Hook for searching apps with debounced input and recent searches support
 * @param initialSearchText Initial search text
 * @param debounceMs Debounce time in milliseconds
 * @returns Object with search results, state, and recent searches
 */
export function useAppSearch(initialSearchText = "", debounceMs = 500): UseAppSearchResult {
  const [searchText, setSearchText] = useState(initialSearchText);
  const [isLoading, setIsLoading] = useState(false);
  const [apps, setApps] = useState<AppDetails[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [totalResults, setTotalResults] = useState<number>(0);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);

  // Load recent searches on mount
  useEffect(() => {
    const loadRecentSearches = async () => {
      try {
        const searches = await getRecentSearches(10);
        setRecentSearches(searches);
      } catch (error) {
        console.error("Error loading recent searches:", error);
      }
    };

    loadRecentSearches();
  }, []);

  // Handle search errors
  const handleSearchError = (err: unknown) => {
    let errorMessage = "An unknown error occurred";
    if (err instanceof Error) {
      errorMessage = err.message;
      process.stderr.write(`Search error: ${err.message}\n`);
    }
    setError(errorMessage);
    showToast({
      style: Toast.Style.Failure,
      title: "Search Failed",
      message: errorMessage,
    });
  };

  // Define the search function
  const performSearch = async (query: string) => {
    if (!query) {
      setApps([]);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Search using iTunes API - no authentication required, rich data immediately
      const itunesResults = await searchITunesApps(query.trim(), 20);

      if (itunesResults.length === 0) {
        setApps([]);
        setTotalResults(0);
        return;
      }

      // Convert iTunes results to AppDetails - already enriched with full metadata
      const mappedApps = itunesResults.map((result) => convertITunesResultToAppDetails(result));

      // Deduplicate apps by bundleId to prevent duplicate keys in React
      const uniqueApps = Array.from(new Map(mappedApps.map((app) => [app.bundleId, app])).values());

      setApps(uniqueApps);
      setTotalResults(uniqueApps.length);

      // Only add to recent searches after successful search with results
      await addRecentSearch(query);

      // Refresh recent searches
      const updatedSearches = await getRecentSearches(10);
      setRecentSearches(updatedSearches);
    } catch (err) {
      handleSearchError(err);
    } finally {
      setIsLoading(false);
    }
  };

  // Create a debounced version of the search function that doesn't change on re-renders
  const debouncedSearch = useCallback(
    debounce((query: string) => {
      performSearch(query);
    }, debounceMs),
    [], // Empty dependency array to ensure stability
  );

  // Update search when text changes
  useEffect(() => {
    if (searchText) {
      debouncedSearch(searchText);
    } else {
      setApps([]);
      setError(null);
    }

    // Cleanup function to cancel any pending debounced calls
    return () => {
      debouncedSearch.cancel();
    };
  }, [searchText, debouncedSearch]);

  // Clear recent searches
  const clearRecentSearchesCallback = useCallback(async () => {
    try {
      await clearRecentSearches();
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

  // Remove a specific recent search
  const removeRecentSearchCallback = useCallback(async (query: string) => {
    try {
      await removeRecentSearch(query);
      const updatedSearches = await getRecentSearches(10);
      setRecentSearches(updatedSearches);
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
  }, []);

  return {
    apps,
    isLoading,
    error,
    totalResults,
    searchText,
    setSearchText: (text: string) => setSearchText(text),
    recentSearches,
    clearRecentSearches: clearRecentSearchesCallback,
    removeRecentSearch: removeRecentSearchCallback,
  };
}
