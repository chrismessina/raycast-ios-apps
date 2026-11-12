import { showError } from "@chrismessina/raycast-kit";
import { logger } from "@chrismessina/raycast-logger";
import { useCallback, useEffect, useState } from "react";
import { LocalStorage, showToast, Toast } from "@raycast/api";
import type { AppDetails } from "../types";
import { STORAGE_KEYS, withoutCachedITunesData } from "../utils/storage";

export interface FavoriteApp {
  app: AppDetails;
  favoritedDate: string;
}

interface UseFavoriteAppsResult {
  favoriteApps: FavoriteApp[];
  isFavorite: (bundleId: string) => boolean;
  addFavorite: (app: AppDetails) => Promise<void>;
  removeFavorite: (bundleId: string) => Promise<void>;
  clearFavorites: () => Promise<void>;
  isLoading: boolean;
}

/**
 * Hook for managing favorite apps with automatic persistence
 * @returns Object with favorite apps and management functions
 */
export function useFavoriteApps(): UseFavoriteAppsResult {
  const [favoriteApps, setFavoriteApps] = useState<FavoriteApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Load favorite apps on mount
  useEffect(() => {
    async function loadFavorites() {
      try {
        const stored = await LocalStorage.getItem<string>(STORAGE_KEYS.FAVORITE_APPS);
        if (stored) {
          const favorites: FavoriteApp[] = JSON.parse(stored);
          setFavoriteApps(favorites.map((item) => ({ ...item, app: withoutCachedITunesData(item.app) })));
        } else {
          setFavoriteApps([]);
        }
      } catch (error) {
        console.error("Error loading favorite apps:", error);
      } finally {
        setIsLoading(false);
      }
    }
    loadFavorites();
  }, []);

  // Change the saved favorites from a fresh read, never from this instance's
  // array: another mounted instance (a detail view over Search) may have saved
  // since this one loaded, and writing back a stale copy would drop its change.
  const mutateFavorites = useCallback(async (change: (favorites: FavoriteApp[]) => FavoriteApp[]) => {
    try {
      const stored = await LocalStorage.getItem<string>(STORAGE_KEYS.FAVORITE_APPS);
      const current: FavoriteApp[] = stored ? JSON.parse(stored) : [];
      const slim = change(current).map((item) => ({ ...item, app: withoutCachedITunesData(item.app) }));
      await LocalStorage.setItem(STORAGE_KEYS.FAVORITE_APPS, JSON.stringify(slim));
      setFavoriteApps(slim);
    } catch (error) {
      console.error("Error persisting favorite apps:", error);
      throw error;
    }
  }, []);

  /**
   * Check if an app is favorited
   */
  const isFavorite = useCallback(
    (bundleId: string): boolean => {
      return favoriteApps.some((item) => item.app.bundleId === bundleId);
    },
    [favoriteApps],
  );

  /**
   * Add an app to favorites
   */
  const addFavorite = useCallback(
    async (app: AppDetails) => {
      try {
        await mutateFavorites((favorites) =>
          favorites.some((item) => item.app.bundleId === app.bundleId)
            ? favorites
            : [...favorites, { app, favoritedDate: new Date().toISOString() }],
        );
        logger.log(`[Favorites] Added app to favorites: ${app.name} (${app.bundleId})`);
        await showToast({
          style: Toast.Style.Success,
          title: "Added to Favorites",
          message: `${app.name} has been added to your favorites`,
        });
      } catch (error) {
        console.error("Error adding favorite app:", error);
        await showError(error, {
          title: "Failed to Add Favorite",
          message: "Could not add app to favorites",
          ignoreAbort: false,
        });
      }
    },
    [mutateFavorites],
  );

  /**
   * Remove an app from favorites
   */
  const removeFavorite = useCallback(
    async (bundleId: string) => {
      try {
        await mutateFavorites((favorites) => favorites.filter((item) => item.app.bundleId !== bundleId));
        logger.log(`[Favorites] Removed app from favorites (${bundleId})`);
        await showToast({
          style: Toast.Style.Success,
          title: "Removed from Favorites",
          message: "App has been removed from your favorites",
        });
      } catch (error) {
        console.error("Error removing favorite app:", error);
        await showError(error, {
          title: "Failed to Remove Favorite",
          message: "Could not remove app from favorites",
          ignoreAbort: false,
        });
      }
    },
    [mutateFavorites],
  );

  /**
   * Clear all favorite apps
   */
  const clearFavorites = useCallback(async () => {
    try {
      await LocalStorage.removeItem(STORAGE_KEYS.FAVORITE_APPS);
      setFavoriteApps([]);
      await showToast({
        style: Toast.Style.Success,
        title: "Favorites Cleared",
        message: "All favorite apps have been removed",
      });
    } catch (error) {
      console.error("Error clearing favorite apps:", error);
      await showError(error, {
        title: "Failed to Clear Favorites",
        message: "Could not clear favorite apps",
        ignoreAbort: false,
      });
    }
  }, []);

  return {
    favoriteApps: favoriteApps.sort(
      (a, b) => new Date(b.favoritedDate).getTime() - new Date(a.favoritedDate).getTime(),
    ),
    isFavorite,
    addFavorite,
    removeFavorite,
    clearFavorites,
    isLoading,
  };
}
