import { Icon, List, ActionPanel, Action } from "@raycast/api";
import { useState, useEffect, useCallback } from "react";
import { formatDate, formatFriendlyDateTime } from "./utils/formatting";
import { useAppDownload, useFavoriteApps, useDownloadHistory } from "./hooks";
import { useAuthNavigation } from "./hooks/use-auth-navigation";
import type { DownloadHistoryItem } from "./utils/storage";
import AppDetailView from "./views/app-detail-view";

type SortOption = "recent" | "oldest" | "mostDownloaded" | "leastDownloaded" | "name";

export default function DownloadHistory() {
  const [filteredHistory, setFilteredHistory] = useState<DownloadHistoryItem[]>([]);
  const [searchText, setSearchText] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("recent");

  const authNavigation = useAuthNavigation();
  const { downloadApp } = useAppDownload(authNavigation);
  const { isFavorite, addFavorite, removeFavorite } = useFavoriteApps();
  const { downloadHistory, removeFromHistory, clearHistory, isLoading } = useDownloadHistory(100);

  // Sort and filter history
  useEffect(() => {
    let filtered = downloadHistory;

    // Apply search filter
    if (searchText) {
      const normalizedSearch = searchText.toLowerCase();
      filtered = filtered.filter(
        (item) =>
          item.app.name.toLowerCase().includes(normalizedSearch) ||
          item.app.sellerName.toLowerCase().includes(normalizedSearch) ||
          item.app.bundleId.toLowerCase().includes(normalizedSearch),
      );
    }

    // Apply sorting
    filtered = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "recent":
          return new Date(b.downloadDate).getTime() - new Date(a.downloadDate).getTime();
        case "oldest":
          return new Date(a.downloadDate).getTime() - new Date(b.downloadDate).getTime();
        case "mostDownloaded":
          return b.downloadCount - a.downloadCount;
        case "leastDownloaded":
          return a.downloadCount - b.downloadCount;
        case "name":
          return a.app.name.localeCompare(b.app.name);
        default:
          return 0;
      }
    });

    setFilteredHistory(filtered);
  }, [downloadHistory, searchText, sortBy]);

  // Toggle favorite status
  const toggleFavorite = useCallback(
    async (item: DownloadHistoryItem) => {
      const isFavorited = isFavorite(item.app.bundleId);

      if (isFavorited) {
        await removeFavorite(item.app.bundleId);
      } else {
        await addFavorite(item.app);
      }
    },
    [isFavorite, addFavorite, removeFavorite],
  );

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search download history..."
      searchBarAccessory={
        <List.Dropdown tooltip="Sort by" onChange={(newValue) => setSortBy(newValue as SortOption)}>
          <List.Dropdown.Item title="Most Recent" value="recent" />
          <List.Dropdown.Item title="Oldest First" value="oldest" />
          <List.Dropdown.Item title="Most Downloaded" value="mostDownloaded" />
          <List.Dropdown.Item title="Least Downloaded" value="leastDownloaded" />
          <List.Dropdown.Item title="Name (A-Z)" value="name" />
        </List.Dropdown>
      }
      actions={
        filteredHistory.length > 0 && (
          <ActionPanel>
            <Action
              title="Clear All History"
              onAction={clearHistory}
              icon={Icon.Trash}
              style={Action.Style.Destructive}
            />
          </ActionPanel>
        )
      }
    >
      {filteredHistory.length === 0 && !isLoading && (
        <List.EmptyView
          title="No Download History"
          description="Your download history will appear here after you download apps."
          icon={Icon.Download}
        />
      )}

      {filteredHistory.map((item, index) => {
        const app = item.app;
        const iconUrl = app.artworkUrl60 || app.artworkUrl512 || app.iconUrl;
        const isFavorited = isFavorite(app.bundleId);
        const friendlyDate = formatFriendlyDateTime(item.downloadDate);
        const downloadCountText = item.downloadCount + "x";
        const downloadCountTooltip =
          "Downloaded " + item.downloadCount + " time" + (item.downloadCount !== 1 ? "s" : "");
        const versionText = "v" + app.version;
        const itemKey = app.bundleId + "-" + index;

        return (
          <List.Item
            key={itemKey}
            title={app.name}
            accessories={[
              { text: friendlyDate, tooltip: formatDate(item.downloadDate) },
              { text: downloadCountText, tooltip: downloadCountTooltip },
              { text: versionText, tooltip: "Version" },
              ...(isFavorited ? [{ icon: Icon.Star, tooltip: "In Favorites" }] : []),
            ]}
            icon={iconUrl ? { source: iconUrl } : Icon.AppWindow}
            actions={
              <ActionPanel>
                <Action.Push
                  title="View App Details"
                  target={<AppDetailView app={app} />}
                  icon={Icon.AppWindowSidebarLeft}
                />
                <Action
                  title="Download Again"
                  onAction={() =>
                    downloadApp(
                      app.bundleId,
                      app.name,
                      app.version,
                      app.price,
                      undefined,
                      undefined,
                      app.fileSizeBytes,
                      app,
                    )
                  }
                  icon={Icon.Download}
                  shortcut={{ modifiers: ["cmd"], key: "d" }}
                />
                <Action
                  title={isFavorited ? "Remove from Favorites" : "Add to Favorites"}
                  onAction={() => toggleFavorite(item)}
                  icon={isFavorited ? Icon.HeartDisabled : Icon.Heart}
                  shortcut={{ modifiers: ["cmd"], key: "f" }}
                />
                <Action
                  title="Delete History Item"
                  onAction={() => removeFromHistory(app.bundleId)}
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                />
                <Action
                  title="Clear All History"
                  onAction={clearHistory}
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
