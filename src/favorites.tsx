import { Icon, List, ActionPanel, Action, Color } from "@raycast/api";
import { useState, useMemo } from "react";
import { useFrecencySorting } from "@raycast/utils";
import { formatPrice } from "./utils/formatting";
import { renderStarRating } from "./utils/common";
import { AppActionPanelContent } from "./components/app-action-panel";
import { ExportActions } from "./components/export-actions";
import { useAppDownload, useFavoriteApps, useLatestVersions, useDownloadHistory } from "./hooks";
import { useAuthNavigation } from "./hooks/use-auth-navigation";
import type { FavoriteApp } from "./hooks/use-favorite-apps";

type SortOption = "frecency" | "alphabetical" | "newest" | "oldest" | "mostDownloaded" | "leastDownloaded";

export default function Favorites() {
  const [sortBy, setSortBy] = useState<SortOption>("frecency");

  const authNavigation = useAuthNavigation();
  const { downloadApp } = useAppDownload(authNavigation);
  const { favoriteApps, clearFavorites, isLoading, addFavorite, removeFavorite } = useFavoriteApps();
  const { getDownloadCount } = useDownloadHistory();

  // Get bundle IDs for version checking
  const bundleIds = useMemo(() => favoriteApps.map((item) => item.app.bundleId), [favoriteApps]);
  const { latestVersions } = useLatestVersions(bundleIds);

  // Use frecency sorting
  const { data: frecencySortedApps, visitItem } = useFrecencySorting(favoriteApps, {
    namespace: "favorites",
    key: (item) => item.app.bundleId,
  });

  // Apply additional sorting based on user selection
  const sortedApps = useMemo(() => {
    const sorted = [...(sortBy === "frecency" ? frecencySortedApps : favoriteApps)];

    switch (sortBy) {
      case "alphabetical":
        sorted.sort((a, b) => a.app.name.localeCompare(b.app.name));
        break;
      case "newest":
        sorted.sort((a, b) => new Date(b.favoritedDate).getTime() - new Date(a.favoritedDate).getTime());
        break;
      case "oldest":
        sorted.sort((a, b) => new Date(a.favoritedDate).getTime() - new Date(b.favoritedDate).getTime());
        break;
      case "mostDownloaded":
        sorted.sort((a, b) => getDownloadCount(b.app.bundleId) - getDownloadCount(a.app.bundleId));
        break;
      case "leastDownloaded":
        sorted.sort((a, b) => getDownloadCount(a.app.bundleId) - getDownloadCount(b.app.bundleId));
        break;
      case "frecency":
      default:
        // Already sorted by frecency
        break;
    }

    return sorted;
  }, [sortBy, frecencySortedApps, favoriteApps, getDownloadCount]);

  // Separate apps with updates from those without
  const appsWithUpdates = useMemo(() => {
    return sortedApps.filter((item) => {
      const latestVersionInfo = latestVersions.get(item.app.bundleId);
      const latestVersion = latestVersionInfo?.latestVersion;
      return latestVersion && latestVersion !== item.app.version;
    });
  }, [sortedApps, latestVersions]);

  const appsWithoutUpdates = useMemo(() => {
    return sortedApps.filter((item) => {
      const latestVersionInfo = latestVersions.get(item.app.bundleId);
      const latestVersion = latestVersionInfo?.latestVersion;
      return !latestVersion || latestVersion === item.app.version;
    });
  }, [sortedApps, latestVersions]);

  // Render a favorite app item
  const renderFavoriteItem = (item: FavoriteApp, index: number) => {
    const app = item.app;
    const rating = app.averageUserRatingForCurrentVersion || app.averageUserRating;
    const ratingText = rating ? renderStarRating(rating) : "";
    const iconUrl = app.artworkUrl60 || app.artworkUrl512 || app.iconUrl;
    const latestVersionInfo = latestVersions.get(app.bundleId);

    // Build version accessories manually (can't use hooks inside render functions)
    const latestVersion = latestVersionInfo?.latestVersion;
    const hasUpdate = latestVersion && latestVersion !== app.version;
    const versionTooltip = hasUpdate ? `Update available: ${app.version} → ${latestVersion}` : "Latest Version";

    const versionAccessories = hasUpdate
      ? [
          { text: `v${app.version} →`, tooltip: versionTooltip },
          { tag: { value: latestVersion, color: Color.Green }, tooltip: versionTooltip },
        ]
      : [{ text: `v${app.version}`, tooltip: versionTooltip }];

    const favoriteAccessory = { icon: { source: Icon.Heart, tintColor: Color.Magenta }, tooltip: "In Favorites" };

    // Combine all accessories
    const accessories = [
      { text: formatPrice(app.price, app.currency) },
      { text: ratingText },
      ...versionAccessories,
      favoriteAccessory,
    ];

    return (
      <List.Item
        key={`${app.bundleId}-${index}`}
        title={app.name}
        subtitle={app.sellerName}
        accessories={accessories}
        icon={iconUrl ? { source: iconUrl } : Icon.AppWindow}
        actions={
          <ActionPanel>
            <AppActionPanelContent
              app={app}
              onDownload={async () => {
                // Get the latest version before downloading
                const latestVersion = latestVersionInfo?.latestVersion || app.version;
                const updatedApp = { ...app, version: latestVersion };

                const result = await downloadApp(
                  app.bundleId,
                  app.name,
                  latestVersion,
                  app.price,
                  undefined,
                  undefined,
                  app.fileSizeBytes,
                  updatedApp,
                );

                // Track visit for frecency
                await visitItem(item);

                return result;
              }}
              showViewDetails={true}
              isFavorited={true}
              onAddFavorite={addFavorite}
              onRemoveFavorite={removeFavorite}
            />
            <ExportActions />
            <ActionPanel.Section>
              <Action
                title="Clear All Favorites"
                onAction={clearFavorites}
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={{ modifiers: ["cmd", "shift"], key: "delete" }}
              />
            </ActionPanel.Section>
          </ActionPanel>
        }
      />
    );
  };

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search favorite apps..."
      searchBarAccessory={
        <List.Dropdown tooltip="Sort by" value={sortBy} onChange={(newValue) => setSortBy(newValue as SortOption)}>
          <List.Dropdown.Item title="Frecency (Smart)" value="frecency" />
          <List.Dropdown.Item title="Alphabetical" value="alphabetical" />
          <List.Dropdown.Item title="Newest" value="newest" />
          <List.Dropdown.Item title="Oldest" value="oldest" />
          <List.Dropdown.Item title="Most Downloaded" value="mostDownloaded" />
          <List.Dropdown.Item title="Least Downloaded" value="leastDownloaded" />
        </List.Dropdown>
      }
      actions={
        favoriteApps.length > 0 ? (
          <ActionPanel>
            <ExportActions />
            <ActionPanel.Section>
              <Action
                title="Clear All Favorites"
                onAction={clearFavorites}
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={{ modifiers: ["cmd", "shift"], key: "delete" }}
              />
            </ActionPanel.Section>
          </ActionPanel>
        ) : undefined
      }
    >
      {favoriteApps.length === 0 && !isLoading && (
        <List.EmptyView
          title="No Favorite Apps"
          description="Apps you add to favorites will appear here for quick access."
          icon={Icon.Heart}
        />
      )}

      {appsWithUpdates.length > 0 && (
        <List.Section title="Available Updates" subtitle={appsWithUpdates.length.toString()}>
          {appsWithUpdates.map((item, index) => renderFavoriteItem(item, index))}
        </List.Section>
      )}

      {appsWithoutUpdates.length > 0 && (
        <List.Section title="Favorite Apps" subtitle={appsWithoutUpdates.length.toString()}>
          {appsWithoutUpdates.map((item, index) => renderFavoriteItem(item, index))}
        </List.Section>
      )}
    </List>
  );
}
