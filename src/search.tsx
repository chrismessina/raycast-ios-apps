import { Icon, List, ActionPanel, Action, Color, LocalStorage, Image } from "@raycast/api";
import { useState, useEffect } from "react";
import { formatPrice, formatDate } from "./utils/formatting";
import { renderStarRating } from "./utils/common";
import { AppActionPanelContent } from "./components/app-action-panel";
import { useAppSearch, useAppDownload, useFavoriteApps } from "./hooks";
import { useAuthNavigation } from "./hooks/use-auth-navigation";
import { GridSearchView } from "./views/grid-search-view";

const VIEW_MODE_STORAGE_KEY = "search-view-mode";

export default function Search() {
  // View state management with persistence
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [isViewModeLoaded, setIsViewModeLoaded] = useState(false);

  // Load saved view mode on mount
  useEffect(() => {
    async function loadViewMode() {
      const savedMode = await LocalStorage.getItem<"list" | "grid">(VIEW_MODE_STORAGE_KEY);
      if (savedMode) {
        setViewMode(savedMode);
      }
      setIsViewModeLoaded(true);
    }
    loadViewMode();
  }, []);

  // Save view mode when it changes
  const handleViewModeChange = async (mode: "list" | "grid") => {
    setViewMode(mode);
    await LocalStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  };

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
  const { isFavorite, addFavorite, removeFavorite } = useFavoriteApps();

  // Download handler
  const handleDownload = async (app: (typeof apps)[0]) => {
    return await downloadApp(
      app.bundleId,
      app.name,
      app.version,
      app.price,
      undefined,
      undefined,
      app.fileSizeBytes,
      app,
    );
  };

  // Show Grid view when in grid mode and has search text
  if (viewMode === "grid" && searchText) {
    return (
      <GridSearchView
        apps={apps}
        isLoading={isLoading || !isViewModeLoaded}
        error={error}
        searchText={searchText}
        totalResults={totalResults}
        isFavorite={isFavorite}
        addFavorite={addFavorite}
        removeFavorite={removeFavorite}
        onDownload={handleDownload}
        onToggleView={() => handleViewModeChange("list")}
        onSearchTextChange={setSearchText}
      />
    );
  }

  // Show recent searches when no search text
  if (!searchText) {
    return (
      <List onSearchTextChange={setSearchText} isLoading={isLoading || !isViewModeLoaded}>
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
      isLoading={isLoading || !isViewModeLoaded}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search for iOS apps..."
      throttle
      navigationTitle="Search iOS Apps"
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

            // Get app icon (standardized to best resolution)
            const iconUrl = app.iconUrl;

            // Check if app is favorited
            const isFavorited = isFavorite(app.bundleId);

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
                  {
                    icon: { source: isFavorited ? Icon.Heart : Icon.HeartDisabled, tintColor: Color.Magenta },
                    tooltip: isFavorited ? "Favorited" : "Not Favorited",
                  },
                ]}
                icon={iconUrl ? { source: iconUrl, mask: Image.Mask.RoundedRectangle } : Icon.AppWindow}
                detail={
                  <List.Item.Detail
                    markdown={`
${iconUrl ? `![App Icon](${iconUrl}?raycast-width=96&raycast-height=96)` : ""}

## ${app.name}

**${app.sellerName}** • ${formatPrice(app.price, app.currency)} • ${ratingText}

${app.description ? app.description.substring(0, 300) + (app.description.length > 300 ? "..." : "") : "No description available"}

---

*Press ⏎ to view full details*
                    `}
                  />
                }
                actions={
                  <ActionPanel>
                    <AppActionPanelContent
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
                      isFavorited={isFavorited}
                      onAddFavorite={addFavorite}
                      onRemoveFavorite={removeFavorite}
                    />
                    <ActionPanel.Section title="View">
                      <Action
                        title="Show Grid View"
                        icon={Icon.AppWindowGrid3x3}
                        onAction={() => handleViewModeChange("grid")}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "g" }}
                      />
                    </ActionPanel.Section>
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}
    </List>
  );
}
