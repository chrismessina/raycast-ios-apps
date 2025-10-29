import { Icon, List, ActionPanel, Action, Color } from "@raycast/api";
import { formatPrice, formatDate } from "./utils/formatting";
import { renderStarRating } from "./utils/common";
import { AppActionPanel } from "./components/app-action-panel";
import { useAppSearch, useAppDownload, useFavoriteApps } from "./hooks";
import { useAuthNavigation } from "./hooks/use-auth-navigation";

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
  const { isFavorite, addFavorite, removeFavorite } = useFavoriteApps();

  // Show recent searches when no search text
  if (!searchText) {
    return (
      <List onSearchTextChange={setSearchText} isLoading={isLoading}>
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
                    isFavorited={isFavorited}
                    onAddFavorite={addFavorite}
                    onRemoveFavorite={removeFavorite}
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
