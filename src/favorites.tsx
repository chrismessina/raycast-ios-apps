import { Icon, List, ActionPanel, Action, Image } from "@raycast/api";
import { useState, useMemo } from "react";
import { useFrecencySorting } from "@raycast/utils";
import { formatFriendlyDateTime } from "./utils/formatting";
import { AppActionPanelContent } from "./components/app-action-panel";
import { ExportActions } from "./components/export-actions";
import { useAppDownload, useFavoriteApps, useDownloadHistory } from "./hooks";
import { useAuthNavigation } from "./hooks/use-auth-navigation";
import type { FavoriteApp } from "./hooks/use-favorite-apps";

type SortOption = "frecency" | "alphabetical" | "newest" | "oldest" | "mostDownloaded" | "leastDownloaded";

export default function Favorites() {
  const [sortBy, setSortBy] = useState<SortOption>("frecency");

  const authNavigation = useAuthNavigation();
  const { downloadApp } = useAppDownload(authNavigation);
  const { favoriteApps, clearFavorites, isLoading, addFavorite, removeFavorite } = useFavoriteApps();
  const { getDownloadCount } = useDownloadHistory();

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

  // Render a favorite app item
  const renderFavoriteItem = (item: FavoriteApp, index: number) => {
    const app = item.app;
    const iconUrl = app.artworkUrl60 || app.artworkUrl512 || app.iconUrl;
    const downloadCount = getDownloadCount(app.bundleId);

    // Build accessories based on sort option
    const accessories: List.Item.Accessory[] = [];

    // Add context-relevant accessories based on sort option
    if (sortBy === "mostDownloaded" || sortBy === "leastDownloaded") {
      // For download-based sorting, show download count
      if (downloadCount > 0) {
        accessories.push({ text: `${downloadCount}×`, tooltip: "Download count" });
      }
    } else {
      // For other sorts (frecency, alphabetical, newest, oldest), show favorited date
      accessories.push({ text: formatFriendlyDateTime(item.favoritedDate), tooltip: "Favorited on" });
    }

    return (
      <List.Item
        key={`${app.bundleId}-${index}`}
        title={app.name}
        subtitle={app.sellerName}
        accessories={accessories}
        icon={iconUrl ? { source: iconUrl, mask: Image.Mask.RoundedRectangle } : Icon.AppWindow}
        actions={
          <ActionPanel>
            <AppActionPanelContent
              app={app}
              onDownload={async () => {
                const result = await downloadApp(
                  app.bundleId,
                  app.name,
                  app.version,
                  app.price,
                  undefined,
                  undefined,
                  app.fileSizeBytes,
                  app,
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
          <List.Dropdown.Item title="Smart Sort" value="frecency" />
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

      {sortedApps.length > 0 && (
        <List.Section title="Favorite Apps" subtitle={sortedApps.length.toString()}>
          {sortedApps.map((item, index) => renderFavoriteItem(item, index))}
        </List.Section>
      )}
    </List>
  );
}
