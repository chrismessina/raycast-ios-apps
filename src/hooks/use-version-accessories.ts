import { Color, Icon, List } from "@raycast/api";
import { useMemo } from "react";
import type { LatestVersionInfo } from "./use-latest-versions";

interface VersionAccessoriesOptions {
  currentVersion: string;
  latestVersionInfo?: LatestVersionInfo;
  isFavorited?: boolean;
  downloadCount?: number;
  downloadDate?: string;
  formatDate?: (date: string) => string;
}

/**
 * Hook for generating consistent version and status accessories across list items
 * @param options Configuration options for accessories
 * @returns Array of List.Item.Accessory objects
 */
export function useVersionAccessories({
  currentVersion,
  latestVersionInfo,
  isFavorited = false,
  downloadCount,
  downloadDate,
  formatDate,
}: VersionAccessoriesOptions): List.Item.Accessory[] {
  return useMemo(() => {
    const accessories: List.Item.Accessory[] = [];

    // Add download date if provided
    if (downloadDate && formatDate) {
      accessories.push({
        text: formatDate(downloadDate),
        tooltip: `Last downloaded ${downloadDate}`,
      });
    }

    // Add download count if provided
    if (downloadCount !== undefined) {
      accessories.push({
        icon: { source: Icon.Download },
        text: downloadCount.toString(),
        tooltip: `Downloaded ${downloadCount} time${downloadCount !== 1 ? "s" : ""}`,
      });
    }

    // Add version information with update indicator
    const latestVersion = latestVersionInfo?.latestVersion;
    const hasUpdate = latestVersion && latestVersion !== currentVersion;
    const versionTooltip = hasUpdate ? `Update available: ${currentVersion} → ${latestVersion}` : "Latest Version";

    if (hasUpdate) {
      accessories.push(
        { text: `v${currentVersion} →`, tooltip: versionTooltip },
        { tag: { value: latestVersion, color: Color.Green }, tooltip: versionTooltip },
      );
    } else {
      accessories.push({ text: `v${currentVersion}`, tooltip: versionTooltip });
    }

    // Add favorite indicator if favorited
    if (isFavorited) {
      accessories.push({
        icon: { source: Icon.Heart, tintColor: Color.Magenta },
        tooltip: "In Favorites",
      });
    }

    return accessories;
  }, [currentVersion, latestVersionInfo, isFavorited, downloadCount, downloadDate, formatDate]);
}
