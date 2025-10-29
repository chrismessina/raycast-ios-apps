import { Icon, List, ActionPanel, Action, showToast, Toast } from "@raycast/api";
import { useState, useEffect, useCallback } from "react";
import { formatPrice, formatDate } from "./utils/formatting";
import { renderStarRating } from "./utils/common";
import { AppActionPanel } from "./components/app-action-panel";
import { useAppSearch, useAppDownload, useExportFavorites } from "./hooks";
import { useAuthNavigation } from "./hooks/useAuthNavigation";
import { getStarredApps, clearStarredApps, type StarredApp } from "./utils/storage";

type FilterOption = "all" | "favorites";

export default function Search() {
  // Use the custom hooks - let useAppSearch manage the search text state
  const {
    apps,
    isLoading,
    error,
    totalResults,
    searchText,
    setSearchText,
    recentSearches,
    clearRecentSearches,
    removeRecentSearch,
  } = useAppSearch("", 500);
  const authNavigation = useAuthNavigation();
  const { downloadApp } = useAppDownload(authNavigation);
  const { exportToMarkdown, exportToCSV } = useExportFavorites();
  const [filter, setFilter] = useState<FilterOption>("all");
  const [starredApps, setStarredApps] = useState<StarredApp[]>([]);
  const [isLoadingStarred, setIsLoadingStarred] = useState(false);

  // Load starred apps when filter changes to favorites
  useEffect(() => {
    if (filter === "favorites") {
      loadStarredApps();
    }
  }, [filter]);

  const loadStarredApps = useCallback(async () => {
    try {
      setIsLoadingStarred(true);
      const apps = await getStarredApps();
      setStarredApps(apps);
    } catch (error) {
      console.error("Error loading starred apps:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Load Favorites",
        message: "Could not load favorite apps",
      });
    } finally {
      setIsLoadingStarred(false);
    }
  }, []);

  // Clear all favorites
  const clearAllFavorites = useCallback(async () => {
    try {
      await clearStarredApps();
      await loadStarredApps();
      await showToast({
        style: Toast.Style.Success,
        title: "Favorites Cleared",
        message: "All favorite apps have been removed",
      });
    } catch (error) {
      console.error("Error clearing favorites:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Clear",
        message: "Could not clear favorite apps",
      });
    }
  }, [loadStarredApps]);

  // Show favorites when filter is set to favorites
  if (filter === "favorites") {
    // Filter starred apps by search text if provided
    const filteredStarred = searchText
      ? starredApps.filter(
          (item) =>
            item.app.name.toLowerCase().includes(searchText.toLowerCase()) ||
            item.app.sellerName.toLowerCase().includes(searchText.toLowerCase()),
        )
      : starredApps;

    return (
      <List
        isLoading={isLoadingStarred}
        onSearchTextChange={setSearchText}
        searchBarPlaceholder="Search favorite apps..."
        searchBarAccessory={
          <List.Dropdown tooltip="Filter" value={filter} onChange={(newValue) => setFilter(newValue as FilterOption)}>
            <List.Dropdown.Item title="All Apps" value="all" />
            <List.Dropdown.Item title="Favorites" value="favorites" />
          </List.Dropdown>
        }
      >
        {filteredStarred.length === 0 && !isLoadingStarred && (
          <List.EmptyView
            title={searchText ? "No Matching Favorites" : "No Favorite Apps"}
            description={
              searchText
                ? "No favorites match your search."
                : "Apps you add to favorites will appear here for quick access."
            }
            icon={Icon.Star}
          />
        )}

        {filteredStarred.map((item, index) => {
          const app = item.app;
          const rating = app.averageUserRatingForCurrentVersion || app.averageUserRating;
          const ratingText = rating ? renderStarRating(rating) : "";
          const iconUrl = app.artworkUrl60 || app.artworkUrl512 || app.iconUrl;

          return (
            <List.Item
              key={`${app.bundleId}-${index}`}
              title={app.name}
              subtitle={app.sellerName}
              accessories={[
                { text: app.version },
                { text: formatPrice(app.price, app.currency) },
                { text: ratingText },
                { icon: Icon.Star, tooltip: "Favorite" },
              ]}
              icon={iconUrl ? { source: iconUrl } : Icon.AppWindow}
              actions={
                <ActionPanel>
                  <ActionPanel.Section>
                    <AppActionPanel
                      app={app}
                      onDownload={() =>
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
                      showViewDetails={true}
                    />
                  </ActionPanel.Section>
                  <ActionPanel.Section title="Export">
                    <Action
                      title="Export Favorites to Markdown"
                      onAction={exportToMarkdown}
                      icon={Icon.Document}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
                    />
                    <Action
                      title="Export Favorites to CSV"
                      onAction={exportToCSV}
                      icon={Icon.Document}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                    />
                  </ActionPanel.Section>
                  <ActionPanel.Section>
                    <Action
                      title="Clear All Favorites"
                      onAction={clearAllFavorites}
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          );
        })}
      </List>
    );
  }

  // Show recent searches when no search text and filter is "all"
  if (!searchText) {
    return (
      <List
        onSearchTextChange={setSearchText}
        isLoading={isLoading}
        searchBarAccessory={
          <List.Dropdown tooltip="Filter" value={filter} onChange={(newValue) => setFilter(newValue as FilterOption)}>
            <List.Dropdown.Item title="All Apps" value="all" />
            <List.Dropdown.Item title="Favorites" value="favorites" />
          </List.Dropdown>
        }
      >
        {recentSearches.length > 0 && (
          <List.Section title="Recent Searches">
            {recentSearches.map((search, index) => (
              <List.Item
                key={`${search.query}-${index}`}
                title={search.query}
                subtitle={new Date(search.timestamp).toLocaleDateString()}
                icon={{ source: "magnifying-glass.svg" }}
                actions={
                  <ActionPanel>
                    <Action title="Search" onAction={() => setSearchText(search.query)} icon={Icon.MagnifyingGlass} />
                    <Action
                      title="Remove Recent Search Item"
                      onAction={() => removeRecentSearch(search.query)}
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    />
                    <Action
                      title="Clear Recent Searches"
                      onAction={clearRecentSearches}
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                    />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        )}
        <List.EmptyView
          title="Type Query to Search"
          description="Search for apps by name, developer, or bundle Id."
          icon="no-view.png"
        />
      </List>
    );
  }

  // Show search results
  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search for iOS apps..."
      throttle
      navigationTitle="Search iOS Apps"
      searchBarAccessory={
        <List.Dropdown tooltip="Filter" value={filter} onChange={(newValue) => setFilter(newValue as FilterOption)}>
          <List.Dropdown.Item title="All Apps" value="all" />
          <List.Dropdown.Item title="Favorites" value="favorites" />
        </List.Dropdown>
      }
    >
      {/* Handle error state */}
      {error && <List.EmptyView title={error} icon={{ source: Icon.Warning }} />}

      {/* Handle empty results */}
      {!error && apps.length === 0 && searchText && (
        <List.EmptyView title="No results found" icon={{ source: Icon.MagnifyingGlass }} />
      )}

      {/* Show results when available */}
      {!error && apps.length > 0 && (
        <List.Section key="search-results" title={totalResults > 0 ? `Results (${totalResults})` : ""}>
          {apps.map((app) => {
            // Get the app rating
            const rating = app.averageUserRatingForCurrentVersion || app.averageUserRating;
            const ratingText = rating ? renderStarRating(rating) : "";

            // Format release date
            const releaseDate = formatDate(app.currentVersionReleaseDate || app.releaseDate);

            // Get app icon
            const iconUrl = app.artworkUrl60 || app.artworkUrl512 || app.iconUrl;

            return (
              <List.Item
                key={app.bundleId}
                title={app.name}
                subtitle={app.sellerName}
                accessories={[
                  { text: app.version },
                  { text: formatPrice(app.price, app.currency) },
                  { text: releaseDate },
                  { text: ratingText },
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
                        <List.Item.Detail.Metadata.Label key="releaseDate" title="Release Date" text={releaseDate} />
                      </List.Item.Detail.Metadata>
                    }
                  />
                }
                actions={
                  <AppActionPanel
                    app={app}
                    onDownload={() =>
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
                    showViewDetails={true}
                  />
                }
              />
            );
          })}
        </List.Section>
      )}
    </List>
  );
}
