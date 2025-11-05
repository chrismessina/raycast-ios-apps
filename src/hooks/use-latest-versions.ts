import { useState, useEffect } from "react";
import { fetchITunesAppDetails } from "../utils/itunes-api";
import { logger } from "@chrismessina/raycast-logger";

export interface LatestVersionInfo {
  bundleId: string;
  latestVersion: string | null;
  isLoading: boolean;
  error: string | null;
}

interface UseLatestVersionsResult {
  latestVersions: Map<string, LatestVersionInfo>;
  isLoading: boolean;
}

/**
 * Hook for fetching latest versions of multiple apps from iTunes API
 * @param bundleIds Array of bundle IDs to fetch versions for
 * @returns Map of bundle IDs to their latest version information
 */
export function useLatestVersions(bundleIds: string[]): UseLatestVersionsResult {
  const [latestVersions, setLatestVersions] = useState<Map<string, LatestVersionInfo>>(new Map());
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (bundleIds.length === 0) {
      return;
    }

    let isMounted = true;

    async function fetchLatestVersions() {
      setIsLoading(true);

      // Initialize all bundle IDs with loading state
      const initialVersions = new Map<string, LatestVersionInfo>();
      bundleIds.forEach((bundleId) => {
        initialVersions.set(bundleId, {
          bundleId,
          latestVersion: null,
          isLoading: true,
          error: null,
        });
      });

      if (isMounted) {
        setLatestVersions(initialVersions);
      }

      // Fetch versions in parallel with rate limiting
      const fetchPromises = bundleIds.map(async (bundleId, index) => {
        // Stagger requests to avoid overwhelming the API
        await new Promise((resolve) => setTimeout(resolve, index * 150));

        try {
          const itunesData = await fetchITunesAppDetails(bundleId);

          if (isMounted) {
            setLatestVersions((prev) => {
              const updated = new Map(prev);
              updated.set(bundleId, {
                bundleId,
                latestVersion: itunesData?.version || null,
                isLoading: false,
                error: itunesData ? null : "Not found",
              });
              return updated;
            });
          }
        } catch (error) {
          logger.error(`[useLatestVersions] Error fetching version for ${bundleId}:`, error);
          if (isMounted) {
            setLatestVersions((prev) => {
              const updated = new Map(prev);
              updated.set(bundleId, {
                bundleId,
                latestVersion: null,
                isLoading: false,
                error: error instanceof Error ? error.message : "Failed to fetch",
              });
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
  }, [bundleIds.join(",")]); // Use join to create stable dependency

  return {
    latestVersions,
    isLoading,
  };
}
