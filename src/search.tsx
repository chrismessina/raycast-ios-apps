import { logger } from "@chrismessina/raycast-logger";
import { useEffect, useState } from "react";
import { Action, ActionPanel, Icon, Keyboard, List, LocalStorage } from "@raycast/api";
import { AppListItem } from "./components/app-list-item";
import { useAppDownload, useAppSearch, useFavoriteApps } from "./hooks";
import { useAuthNavigation } from "./hooks/use-auth-navigation";
import { GridSearchView } from "./views/grid-search-view";

const VIEW_MODE_STORAGE_KEY = "search-view-mode";
const PLATFORM_ENTITY_STORAGE_KEY = "search-platform-entity";

/**
 * iTunes filters platform through the single-valued `entity` query param.
 * "All Apps" is the plain `software` entity (iPhone + universal apps), so a
 * separate "iPhone" option would issue a byte-identical request — omitted.
 * iTunes has no visionOS entity.
 */
// One platform at a time — iTunes' `entity` param is single-valued, and there is
// no all-platforms entity to offer. `software` is specifically the iPhone
// storefront, NOT a superset: Procreate is iPad-only and does not appear under
// `software` at all (you get Procreate Pocket instead), so labelling it
// "All Apps" claimed a breadth it does not have.
const PLATFORM_OPTIONS: { title: string; value: string; icon: Icon }[] = [
  { title: "iPhone", value: "software", icon: Icon.Mobile },
  { title: "iPad", value: "iPadSoftware", icon: Icon.AppWindowSidebarLeft },
  { title: "Mac", value: "macSoftware", icon: Icon.Desktop },
  { title: "Apple TV", value: "tvSoftware", icon: Icon.Monitor },
];
const DEFAULT_PLATFORM_ENTITY = PLATFORM_OPTIONS[0].value;

export default function Search() {
  // View state management with persistence
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [isViewModeLoaded, setIsViewModeLoaded] = useState(false);

  // Platform filter (iTunes `entity`), persisted like the view mode above
  const [platformEntity, setPlatformEntity] = useState(DEFAULT_PLATFORM_ENTITY);

  // Load saved view mode and platform filter on mount
  useEffect(() => {
    async function loadPreferences() {
      // Restoring a preference is a convenience; failing to restore one must
      // never gate the UI. Before this was `Promise.all` + an unguarded flag,
      // so a single rejected read left every Search surface on a permanent
      // spinner. Defaults are correct on their own — always release the gate.
      try {
        const [savedMode, savedEntity] = await Promise.all([
          LocalStorage.getItem<"list" | "grid">(VIEW_MODE_STORAGE_KEY),
          LocalStorage.getItem<string>(PLATFORM_ENTITY_STORAGE_KEY),
        ]);
        if (savedMode) {
          setViewMode(savedMode);
        }
        if (savedEntity && PLATFORM_OPTIONS.some((option) => option.value === savedEntity)) {
          setPlatformEntity(savedEntity);
        }
      } catch (error) {
        logger.error("[Search] Could not restore saved preferences; using defaults:", error);
      } finally {
        setIsViewModeLoaded(true);
      }
    }
    loadPreferences();
  }, []);

  const handlePlatformChange = async (entity: string) => {
    setPlatformEntity(entity);
    await LocalStorage.setItem(PLATFORM_ENTITY_STORAGE_KEY, entity);
  };

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
  } = useAppSearch("", 500, platformEntity);

  // List.Dropdown and Grid.Dropdown are the same component, so one element
  // serves both view modes.
  const platformDropdown = (
    <List.Dropdown tooltip="Show results for one platform" value={platformEntity} onChange={handlePlatformChange}>
      {/* Sectioned so the single-choice nature reads at a glance. */}
      <List.Dropdown.Section title="Platform">
        {PLATFORM_OPTIONS.map((option) => (
          <List.Dropdown.Item key={option.value} title={option.title} value={option.value} icon={option.icon} />
        ))}
      </List.Dropdown.Section>
    </List.Dropdown>
  );
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
        searchBarAccessory={platformDropdown}
      />
    );
  }

  // Show recent searches when no search text
  if (!searchText) {
    return (
      <List
        onSearchTextChange={setSearchText}
        isLoading={isLoading || !isViewModeLoaded}
        searchBarAccessory={platformDropdown}
      >
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
      searchBarAccessory={platformDropdown}
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
