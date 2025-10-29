import { LocalStorage, showToast, Toast } from "@raycast/api";
import { useState, useEffect, useCallback } from "react";
import { STORAGE_KEYS } from "../utils/storage";
import type { AppDetails } from "../types";
import { logger } from "@chrismessina/raycast-logger";

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
          setFavoriteApps(favorites);
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

  // Persist to LocalStorage
  const persistFavorites = useCallback(async (favorites: FavoriteApp[]) => {
    try {
      await LocalStorage.setItem(STORAGE_KEYS.FAVORITE_APPS, JSON.stringify(favorites));
      setFavoriteApps(favorites);
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
        // Check if already favorited
        if (favoriteApps.some((item) => item.app.bundleId === app.bundleId)) {
          return;
        }

        const newFavorites: FavoriteApp[] = [
          ...favoriteApps,
          {
            app,
            favoritedDate: new Date().toISOString(),
          },
        ];

        await persistFavorites(newFavorites);
        logger.log(`[Favorites] Added app to favorites: ${app.name} (${app.bundleId})`);
        await showToast({
          style: Toast.Style.Success,
          title: "Added to Favorites",
          message: `${app.name} has been added to your favorites`,
        });
      } catch (error) {
        console.error("Error adding favorite app:", error);
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to Add Favorite",
          message: "Could not add app to favorites",
        });
      }
    },
    [favoriteApps, persistFavorites],
  );

  /**
   * Remove an app from favorites
   */
  const removeFavorite = useCallback(
    async (bundleId: string) => {
      try {
        const appToRemove = favoriteApps.find((item) => item.app.bundleId === bundleId);
        const filtered = favoriteApps.filter((item) => item.app.bundleId !== bundleId);
        await persistFavorites(filtered);
        logger.log(`[Favorites] Removed app from favorites: ${appToRemove?.app.name || "Unknown"} (${bundleId})`);
        await showToast({
          style: Toast.Style.Success,
          title: "Removed from Favorites",
          message: "App has been removed from your favorites",
        });
      } catch (error) {
        console.error("Error removing favorite app:", error);
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to Remove Favorite",
          message: "Could not remove app from favorites",
        });
      }
    },
    [favoriteApps, persistFavorites],
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
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Clear Favorites",
        message: "Could not clear favorite apps",
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
