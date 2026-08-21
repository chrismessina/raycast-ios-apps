import { logger } from "@chrismessina/raycast-logger";
import { debounce } from "lodash";
import { useCallback, useEffect, useState } from "react";
import { showToast, Toast } from "@raycast/api";
import type { AppDetails, ITunesResult } from "../types";
import {
  convertITunesResultToAppDetails,
  fetchITunesAppDetails,
  lookupITunesAppById,
  searchITunesApps,
} from "../utils/itunes-api";
import { parseAppQuery } from "../utils/parse-app-query";
import { useRecentSearches, type RecentSearch } from "./use-recent-searches";

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
  isLoadingSearches: boolean;
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

  // Use the recent searches hook
  const {
    recentSearches,
    addRecentSearch: addSearch,
    clearRecentSearches: clearSearches,
    removeRecentSearch: removeSearch,
    isLoading: isLoadingSearches,
  } = useRecentSearches(10);

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
      // An App Store URL, track ID, or bundle ID resolves through the exact
      // lookup endpoint — term search misses apps Apple has not indexed yet.
      // If lookup finds nothing (e.g. a dotted string that only looked like a
      // bundle ID), fall back to a normal term search rather than dead-ending.
      const parsed = parseAppQuery(query);
      logger.log(`[Search] "${query}" parsed as ${parsed.kind} → "${parsed.value}"`);
      let itunesResults: ITunesResult[] = [];

      if (parsed.kind === "trackId") {
        const app = await lookupITunesAppById(parsed.value);
        itunesResults = app ? [app] : [];
        logger.log(`[Search] Track ID lookup for ${parsed.value}: ${app ? `matched "${app.trackName}"` : "no match"}`);
      } else if (parsed.kind === "bundleId") {
        const app = await fetchITunesAppDetails(parsed.value);
        itunesResults = app ? [app] : [];
        logger.log(`[Search] Bundle ID lookup for ${parsed.value}: ${app ? `matched "${app.trackName}"` : "no match"}`);
      }

      // A pasted App Store URL has nothing sensible to term-search, so a miss
      // there stays a miss. Every other classification falls back — a bare
      // number can be an app's actual name, and a dotted string can just look
      // like a bundle ID.
      const canFallBackToTermSearch = parsed.kind !== "trackId" || !parsed.fromUrl;

      if (itunesResults.length === 0 && canFallBackToTermSearch) {
        if (parsed.kind !== "term") {
          logger.log(`[Search] ${parsed.kind} lookup empty; falling back to term search for "${query}"`);
        }
        // Search using iTunes API - no authentication required, rich data immediately
        itunesResults = await searchITunesApps(query.trim(), 20);
        logger.log(`[Search] Term search for "${query}" returned ${itunesResults.length} result(s)`);
      }

      if (itunesResults.length === 0) {
        setApps([]);
        setTotalResults(0);
        return;
      }

      // Convert iTunes results to AppDetails - already enriched with full metadata
      const mappedApps = itunesResults.map((result) => convertITunesResultToAppDetails(result));

      // Deduplicate apps by bundleId to prevent duplicate keys in React
      // Key on `id` when iTunes omits a bundleId — otherwise every partial
      // record collapses onto the same empty-string key and results vanish.
      const uniqueApps = Array.from(new Map(mappedApps.map((app) => [app.bundleId || app.id, app])).values());

      logger.log(`[Search] Showing ${uniqueApps.length} app(s) after de-duplicating by bundle ID`);
      setApps(uniqueApps);
      setTotalResults(uniqueApps.length);

      // Only add to recent searches after successful search with results and minimum length
      if (query.length >= 3) {
        await addSearch(query);
      }
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

  return {
    apps,
    isLoading,
    error,
    totalResults,
    searchText,
    setSearchText: (text: string) => setSearchText(text),
    recentSearches,
    clearRecentSearches: clearSearches,
    removeRecentSearch: removeSearch,
    isLoadingSearches,
  };
}
