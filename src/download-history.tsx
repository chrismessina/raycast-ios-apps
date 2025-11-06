import { Icon, List, ActionPanel, Action, Color } from "@raycast/api";
import { useState, useEffect, useCallback, useMemo } from "react";
import { formatDate, formatFriendlyDateTime, cleanAppNameForFilename } from "./utils/formatting";
import { useAppDownload, useFavoriteApps, useDownloadHistory, useLatestVersions } from "./hooks";
import { useAuthNavigation } from "./hooks/use-auth-navigation";
import type { DownloadHistoryItem } from "./utils/storage";
import AppDetailView from "./views/app-detail-view";

type SortOption = "recent" | "oldest" | "mostDownloaded" | "leastDownloaded" | "name";

export default function DownloadHistory() {
  const [filteredHistory, setFilteredHistory] = useState<DownloadHistoryItem[]>([]);
  const [searchText, setSearchText] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [refreshKey, setRefreshKey] = useState(0);

  const authNavigation = useAuthNavigation();
  const { downloadApp } = useAppDownload(authNavigation);
  const { isFavorite, addFavorite, removeFavorite } = useFavoriteApps();
  const { downloadHistory, removeFromHistory, clearHistory, refresh, isLoading } = useDownloadHistory(100);

  // Get bundle IDs for version checking - include refreshKey to force re-fetch
  const bundleIds = useMemo(() => downloadHistory.map((item) => item.app.bundleId), [downloadHistory, refreshKey]);
  const { latestVersions } = useLatestVersions(bundleIds);

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
      const friendlyDate = formatFriendlyDateTime(item.downloadDate);
      const downloadCountText = item.downloadCount + "x";
      const downloadCountTooltip = "Downloaded " + item.downloadCount + " time" + (item.downloadCount !== 1 ? "s" : "");

      // Get latest version info
      const latestVersionInfo = latestVersions.get(app.bundleId);
      const latestVersion = latestVersionInfo?.latestVersion;
      const hasUpdate = latestVersion && latestVersion !== app.version;

      // Format version text with update indicator
      const versionTooltip = hasUpdate ? `Update available: ${app.version} → ${latestVersion}` : "Latest Version";

      const itemKey = app.bundleId + "-" + index;

      return (
        <List.Item
          key={itemKey}
          title={cleanAppNameForFilename(app.name)}
          accessories={[
            { text: friendlyDate, tooltip: "Last downloaded " + formatDate(item.downloadDate) },
            { text: downloadCountText, tooltip: downloadCountTooltip },
            ...(hasUpdate
              ? [
                  { text: `v${app.version} →`, tooltip: versionTooltip },
                  { tag: { value: latestVersion, color: Color.Green }, tooltip: versionTooltip },
                ]
              : [{ text: `v${app.version}`, tooltip: versionTooltip }]),
            ...(isFavorited
              ? [{ icon: { source: Icon.Heart, tintColor: Color.Magenta }, tooltip: "In Favorites" }]
              : []),
          ]}
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
                  
                  // Trigger a refresh of latest versions after download completes
                  setRefreshKey((prev) => prev + 1);
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
    [isFavorite, latestVersions, downloadApp, toggleFavorite, removeFromHistory, clearHistory, refresh],
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
