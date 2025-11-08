import { useState, useEffect, useCallback } from "react";
import { fetchITunesAppDetails } from "../utils/itunes-api";
import { logger } from "@chrismessina/raycast-logger";

export interface LatestVersionInfo {
  bundleId: string;
  latestVersion: string | null;
  isLoading: boolean;
  error: string | null;
}

interface CacheEntry {
  data: LatestVersionInfo;
  timestamp: number;
}

interface UseLatestVersionsResult {
  latestVersions: Map<string, LatestVersionInfo>;
  isLoading: boolean;
  forceRefresh: () => void;
}

// Global cache with 5-minute TTL (300,000 ms)
const CACHE_TTL = 5 * 60 * 1000;
const versionCache = new Map<string, CacheEntry>();

/**
 * Hook for fetching latest versions of multiple apps from iTunes API
 * with 5-minute caching to reduce API calls
 * @param bundleIds Array of bundle IDs to fetch versions for
 * @param skipCache Optional flag to skip cache and force refresh
 * @returns Map of bundle IDs to their latest version information and a forceRefresh function
 */
export function useLatestVersions(bundleIds: string[], skipCache = false): UseLatestVersionsResult {
  const [latestVersions, setLatestVersions] = useState<Map<string, LatestVersionInfo>>(new Map());
  const [isLoading, setIsLoading] = useState(false);

  // Function to force refresh by clearing cache
  const forceRefresh = useCallback(() => {
    bundleIds.forEach((bundleId) => {
      versionCache.delete(bundleId);
    });
    // Trigger a re-fetch by updating state
    setLatestVersions(new Map());
  }, [bundleIds]);

  useEffect(() => {
    if (bundleIds.length === 0) {
      return;
    }

    let isMounted = true;

    async function fetchLatestVersions() {
      setIsLoading(true);

      // Check cache and separate into cached and uncached bundle IDs
      const now = Date.now();
      const cachedVersions = new Map<string, LatestVersionInfo>();
      const bundleIdsToFetch: string[] = [];

      bundleIds.forEach((bundleId) => {
        const cached = versionCache.get(bundleId);
        if (!skipCache && cached && now - cached.timestamp < CACHE_TTL) {
          // Use cached data
          cachedVersions.set(bundleId, cached.data);
        } else {
          // Need to fetch
          bundleIdsToFetch.push(bundleId);
        }
      });

      // Set cached versions immediately
      if (cachedVersions.size > 0) {
        setLatestVersions((prev) => {
          const updated = new Map(prev);
          cachedVersions.forEach((value, key) => {
            updated.set(key, value);
          });
          return updated;
        });
      }

      // If nothing to fetch, we're done
      if (bundleIdsToFetch.length === 0) {
        if (isMounted) {
          setIsLoading(false);
        }
        return;
      }

      // Initialize loading state for bundle IDs to fetch
      const initialVersions = new Map<string, LatestVersionInfo>();
      bundleIdsToFetch.forEach((bundleId) => {
        initialVersions.set(bundleId, {
          bundleId,
          latestVersion: null,
          isLoading: true,
          error: null,
        });
      });

      if (isMounted) {
        setLatestVersions((prev) => {
          const updated = new Map(prev);
          initialVersions.forEach((value, key) => {
            updated.set(key, value);
          });
          return updated;
        });
      }

      // Fetch versions in parallel with rate limiting
      const fetchPromises = bundleIdsToFetch.map(async (bundleId, index) => {
        // Stagger requests to avoid overwhelming the API
        await new Promise((resolve) => setTimeout(resolve, index * 150));

        try {
          const itunesData = await fetchITunesAppDetails(bundleId);
          const versionInfo: LatestVersionInfo = {
            bundleId,
            latestVersion: itunesData?.version || null,
            isLoading: false,
            error: itunesData ? null : "Not found",
          };

          // Cache the result
          versionCache.set(bundleId, {
            data: versionInfo,
            timestamp: Date.now(),
          });

          if (isMounted) {
            setLatestVersions((prev) => {
              const updated = new Map(prev);
              updated.set(bundleId, versionInfo);
              return updated;
            });
          }
        } catch (error) {
          logger.error(`[useLatestVersions] Error fetching version for ${bundleId}:`, error);
          const versionInfo: LatestVersionInfo = {
            bundleId,
            latestVersion: null,
            isLoading: false,
            error: error instanceof Error ? error.message : "Failed to fetch",
          };

          // Cache the error result too
          versionCache.set(bundleId, {
            data: versionInfo,
            timestamp: Date.now(),
          });

          if (isMounted) {
            setLatestVersions((prev) => {
              const updated = new Map(prev);
              updated.set(bundleId, versionInfo);
              return updated;
            });
          }
        }
      });

      await Promise.all(fetchPromises);

      if (isMounted) {
        setIsLoading(false);
      }
    }

    fetchLatestVersions();

    return () => {
      isMounted = false;
    };
  }, [bundleIds.join(","), skipCache]); // Use join to create stable dependency

  return {
    latestVersions,
    isLoading,
    forceRefresh,
  };
}
