import { Icon, List, ActionPanel, Action } from "@raycast/api";
import { useState, useEffect, useCallback, useMemo } from "react";
import { formatFriendlyDateTime, cleanAppNameForFilename } from "./utils/formatting";
import { useAppDownload, useFavoriteApps, useDownloadHistory, useLatestVersions, useVersionAccessories } from "./hooks";
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
  const { downloadHistory, removeFromHistory, clearHistory, refresh, isLoading } = useDownloadHistory(100);

  // Get bundle IDs for version checking
  const bundleIds = useMemo(() => downloadHistory.map((item) => item.app.bundleId), [downloadHistory]);
  const { latestVersions, forceRefresh } = useLatestVersions(bundleIds);

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

  // Separate apps with updates from those without
  const appsWithUpdates = useMemo(() => {
    return filteredHistory.filter((item) => {
      const latestVersionInfo = latestVersions.get(item.app.bundleId);
      const latestVersion = latestVersionInfo?.latestVersion;
      return latestVersion && latestVersion !== item.app.version;
    });
  }, [filteredHistory, latestVersions]);

  const appsWithoutUpdates = useMemo(() => {
    return filteredHistory.filter((item) => {
      const latestVersionInfo = latestVersions.get(item.app.bundleId);
      const latestVersion = latestVersionInfo?.latestVersion;
      return !latestVersion || latestVersion === item.app.version;
    });
  }, [filteredHistory, latestVersions]);

  // Pre-compute accessories for all items
  const accessoriesMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof useVersionAccessories>>();
    filteredHistory.forEach((item) => {
      const latestVersionInfo = latestVersions.get(item.app.bundleId);
      const isFavorited = isFavorite(item.app.bundleId);

      const accessories = [
        ...(latestVersionInfo?.latestVersion && latestVersionInfo.latestVersion !== item.app.version
          ? [{ tag: { value: `Update: ${latestVersionInfo.latestVersion}`, color: "#00FF00" } }]
          : []),
        ...(isFavorited ? [{ icon: Icon.Heart, tooltip: "Favorite" }] : []),
        { text: `${item.downloadCount}×`, tooltip: "Download count" },
        { text: formatFriendlyDateTime(item.downloadDate), tooltip: "Last downloaded" },
      ];

      map.set(item.app.bundleId, accessories);
    });
    return map;
  }, [filteredHistory, latestVersions, isFavorite]);

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

  // Render a list item for an app
  const renderListItem = useCallback(
    (item: DownloadHistoryItem, index: number) => {
      const app = item.app;
      const iconUrl = app.artworkUrl60 || app.artworkUrl512 || app.iconUrl;
      const isFavorited = isFavorite(app.bundleId);
      const accessories = accessoriesMap.get(app.bundleId) || [];

      const itemKey = app.bundleId + "-" + index;

      return (
        <List.Item
          key={itemKey}
          title={cleanAppNameForFilename(app.name)}
          accessories={accessories}
          icon={iconUrl ? { source: iconUrl } : Icon.AppWindow}
          actions={
            <ActionPanel>
              <Action
                title="Download Again"
                onAction={async () => {
                  // Get the latest version info before downloading
                  const latestVersionInfo = latestVersions.get(app.bundleId);
                  const versionToDownload = latestVersionInfo?.latestVersion || app.version;

                  // Create updated app object with latest version
                  const updatedApp = {
                    ...app,
                    version: versionToDownload,
                  };

                  await downloadApp(
                    app.bundleId,
                    app.name,
                    versionToDownload,
                    app.price,
                    undefined,
                    undefined,
                    app.fileSizeBytes,
                    updatedApp,
                  );

                  // Refresh download history to update counts and versions
                  await refresh();
                }}
                icon={Icon.Download}
                shortcut={{ modifiers: ["cmd"], key: "s" }}
              />
              <Action.Push
                title="View App Details"
                target={<AppDetailView app={app} />}
                icon={Icon.AppWindowSidebarLeft}
                shortcut={{ modifiers: ["cmd"], key: "i" }}
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
    },
    [isFavorite, latestVersions, downloadApp, toggleFavorite, removeFromHistory, clearHistory, refresh, accessoriesMap],
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
              title="Check for Updates"
              onAction={forceRefresh}
              icon={Icon.RotateClockwise}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
            />
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

      {appsWithUpdates.length > 0 && (
        <List.Section title="Available Updates" subtitle={appsWithUpdates.length.toString()}>
          {appsWithUpdates.map((item, index) => renderListItem(item, index))}
        </List.Section>
      )}

      {appsWithoutUpdates.length > 0 && (
        <List.Section title="Downloaded Apps" subtitle={appsWithoutUpdates.length.toString()}>
          {appsWithoutUpdates.map((item, index) => renderListItem(item, index))}
        </List.Section>
      )}
    </List>
  );
}
