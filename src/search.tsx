import { useEffect, useState } from "react";
import { Action, ActionPanel, Icon, Keyboard, List, LocalStorage } from "@raycast/api";
import { AppListItem } from "./components/app-list-item";
import { useAppDownload, useAppSearch, useFavoriteApps } from "./hooks";
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
  const { downloadAppDetails } = useAppDownload(authNavigation);
  const { isFavorite, addFavorite, removeFavorite } = useFavoriteApps();

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
        onDownload={downloadAppDetails}
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
                icon={Icon.MagnifyingGlass}
                actions={
                  <ActionPanel>
                    <Action title="Search" onAction={() => setSearchText(search.query)} icon={Icon.MagnifyingGlass} />
                    <Action
                      title="Remove Recent Search Item"
                      onAction={() => removeRecentSearch(search.query)}
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={Keyboard.Shortcut.Common.Remove}
                    />
                    <Action
                      title="Clear Recent Searches"
                      onAction={clearRecentSearches}
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={Keyboard.Shortcut.Common.RemoveAll}
                    />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        )}
        <List.EmptyView
          title="Type Query to Search"
          description="Search by name, developer, bundle ID, App Store URL, or app ID."
          icon="no-view@256.png"
        />
      </List>
    );
  }

  // Show search results
  return (
    <List
      isLoading={isLoading || !isViewModeLoaded}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search by name, App Store URL, or app ID..."
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
          {apps.map((app) => (
            <AppListItem
              key={app.bundleId || app.id}
              app={app}
              subtitle={app.sellerName}
              isFavorited={isFavorite(app.bundleId)}
              onDownload={downloadAppDetails}
              onAddFavorite={addFavorite}
              onRemoveFavorite={removeFavorite}
            >
              <ActionPanel.Section title="View">
                <Action
                  title="Show Grid View"
                  icon={Icon.AppWindowGrid3x3}
                  onAction={() => handleViewModeChange("grid")}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "g" }}
                />
              </ActionPanel.Section>
            </AppListItem>
          ))}
        </List.Section>
      )}
    </List>
  );
}
