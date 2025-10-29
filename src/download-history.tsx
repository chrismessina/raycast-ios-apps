import { Icon, List, ActionPanel, Action, showToast, Toast } from "@raycast/api";
import { useState, useEffect, useCallback } from "react";
import { formatPrice, formatDate } from "./utils/formatting";
import { renderStarRating } from "./utils/common";
import {
  getDownloadHistory,
  removeFromDownloadHistory,
  clearDownloadHistory,
  addStarredApp,
  removeStarredApp,
  isAppStarred,
  type DownloadHistoryItem,
} from "./utils/storage";
import { useAppDownload } from "./hooks";
import { useAuthNavigation } from "./hooks/useAuthNavigation";

type SortOption = "date" | "name" | "developer" | "bundleId";

export default function DownloadHistory() {
  const [history, setHistory] = useState<DownloadHistoryItem[]>([]);
  const [filteredHistory, setFilteredHistory] = useState<DownloadHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("date");
  const [starredApps, setStarredApps] = useState<Set<string>>(new Set());

  const authNavigation = useAuthNavigation();
  const { downloadApp } = useAppDownload(authNavigation);

  // Load download history
  const loadHistory = useCallback(async () => {
    try {
      setIsLoading(true);
      const historyData = await getDownloadHistory(50);
      setHistory(historyData);
      setFilteredHistory(historyData);

      // Load starred apps status
      const starredStatus = new Set<string>();
      for (const item of historyData) {
        if (await isAppStarred(item.app.bundleId)) {
          starredStatus.add(item.app.bundleId);
        }
      }
      setStarredApps(starredStatus);
    } catch (error) {
      console.error("Error loading download history:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Load History",
        message: "Could not load download history",
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Sort and filter history
  useEffect(() => {
    let filtered = history;

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
        case "date":
          return new Date(b.downloadDate).getTime() - new Date(a.downloadDate).getTime();
        case "name":
          return a.app.name.localeCompare(b.app.name);
        case "developer":
          return a.app.sellerName.localeCompare(b.app.sellerName);
        case "bundleId":
          return a.app.bundleId.localeCompare(b.app.bundleId);
        default:
          return 0;
      }
    });

    setFilteredHistory(filtered);
  }, [history, searchText, sortBy]);

  // Remove item from history
  const removeHistoryItem = useCallback(
    async (bundleId: string) => {
      try {
        await removeFromDownloadHistory(bundleId);
        await loadHistory();
        await showToast({
          style: Toast.Style.Success,
          title: "Removed from History",
          message: "App removed from download history",
        });
      } catch (error) {
        console.error("Error removing from history:", error);
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to Remove",
          message: "Could not remove app from history",
        });
      }
    },
    [loadHistory],
  );

  // Clear all history
  const clearAllHistory = useCallback(async () => {
    try {
      await clearDownloadHistory();
      await loadHistory();
      await showToast({
        style: Toast.Style.Success,
        title: "History Cleared",
        message: "Download history has been cleared",
      });
    } catch (error) {
      console.error("Error clearing history:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Clear",
        message: "Could not clear download history",
      });
    }
  }, [loadHistory]);

  // Toggle starred status
  const toggleStarred = useCallback(
    async (item: DownloadHistoryItem) => {
      try {
        const isStarred = starredApps.has(item.app.bundleId);

        if (isStarred) {
          await removeStarredApp(item.app.bundleId);
          setStarredApps((prev) => {
            const newSet = new Set(prev);
            newSet.delete(item.app.bundleId);
            return newSet;
          });
          await showToast({
            style: Toast.Style.Success,
            title: "Removed from Favorites",
            message: `${item.app.name} removed from favorites`,
          });
        } else {
          await addStarredApp(item.app);
          setStarredApps((prev) => new Set(prev).add(item.app.bundleId));
          await showToast({
            style: Toast.Style.Success,
            title: "Added to Favorites",
            message: `${item.app.name} added to favorites`,
          });
        }
      } catch (error) {
        console.error("Error toggling starred status:", error);
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to Update Favorites",
          message: "Could not update favorite status",
        });
      }
    },
    [starredApps],
  );

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search download history..."
      searchBarAccessory={
        <List.Dropdown tooltip="Sort by" onChange={(newValue) => setSortBy(newValue as SortOption)}>
          <List.Dropdown.Item title="Date" value="date" />
          <List.Dropdown.Item title="Name" value="name" />
          <List.Dropdown.Item title="Developer" value="developer" />
          <List.Dropdown.Item title="Bundle ID" value="bundleId" />
        </List.Dropdown>
      }
      actions={
        filteredHistory.length > 0 && (
          <ActionPanel>
            <Action
              title="Clear All History"
              onAction={clearAllHistory}
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
        const rating = app.averageUserRatingForCurrentVersion || app.averageUserRating;
        const ratingText = rating ? renderStarRating(rating) : "";
        const releaseDate = formatDate(app.currentVersionReleaseDate || app.releaseDate);
        const iconUrl = app.artworkUrl60 || app.artworkUrl512 || app.iconUrl;
        const isStarred = starredApps.has(app.bundleId);

        return (
          <List.Item
            key={`${app.bundleId}-${index}`}
            title={app.name}
            subtitle={app.sellerName}
            accessories={[
              { text: `Downloaded ${item.downloadCount} time${item.downloadCount !== 1 ? "s" : ""}` },
              { text: app.version },
              { text: formatPrice(app.price, app.currency) },
              { text: formatDate(item.downloadDate) },
              { text: ratingText },
              ...(isStarred ? [{ icon: Icon.Star, tooltip: "In Favorites" }] : []),
            ]}
            icon={iconUrl ? { source: iconUrl } : Icon.AppWindow}
            detail={
              <List.Item.Detail
                markdown={`
                # ${app.name} ${app.version}
                
                ${iconUrl ? `![App Icon](${iconUrl})` : ""}
                
                **Developer:** ${app.sellerName}
                
                **Price:** ${formatPrice(app.price, app.currency)}
                
                **Rating:** ${ratingText}
                
                **Bundle ID:** \`${app.bundleId}\`
                
                **Downloaded:** ${formatDate(item.downloadDate)} (${item.downloadCount} times)
                
                **Release Date:** ${releaseDate}
                
                **Genre:** ${app.genres?.join(", ") || "Not available"}
                
                ## Description
                ${app.description || "No description available"}
                `}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label key="name" title="Name" text={app.name} />
                    <List.Item.Detail.Metadata.Label key="version" title="Version" text={app.version} />
                    <List.Item.Detail.Metadata.Label key="developer" title="Developer" text={app.sellerName} />
                    <List.Item.Detail.Metadata.Label
                      key="price"
                      title="Price"
                      text={formatPrice(app.price, app.currency)}
                    />
                    <List.Item.Detail.Metadata.Label key="rating" title="Rating" text={ratingText} />
                    <List.Item.Detail.Metadata.Label key="bundleId" title="Bundle ID" text={app.bundleId} />
                    <List.Item.Detail.Metadata.Label
                      key="downloadDate"
                      title="Downloaded"
                      text={formatDate(item.downloadDate)}
                    />
                    <List.Item.Detail.Metadata.Label
                      key="downloadCount"
                      title="Download Count"
                      text={item.downloadCount.toString()}
                    />
                    <List.Item.Detail.Metadata.Label key="releaseDate" title="Release Date" text={releaseDate} />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
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
                />
                <Action
                  title={isStarred ? "Remove from Favorites" : "Add to Favorites"}
                  onAction={() => toggleStarred(item)}
                  icon={isStarred ? Icon.StarDisabled : Icon.Star}
                />
                <Action
                  title="Delete History Item"
                  onAction={() => removeHistoryItem(app.bundleId)}
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                />
                <Action
                  title="Clear All History"
                  onAction={clearAllHistory}
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
