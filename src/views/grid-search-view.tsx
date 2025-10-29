import { Grid, Icon, Color, ActionPanel, Action } from "@raycast/api";
import { AppDetails } from "../types";
import { AppActionPanelContent } from "../components/app-action-panel";

interface GridSearchViewProps {
  apps: AppDetails[];
  isLoading: boolean;
  error: string | null;
  searchText: string;
  totalResults: number;
  isFavorite: (bundleId: string) => boolean;
  addFavorite: (app: AppDetails) => Promise<void>;
  removeFavorite: (bundleId: string) => Promise<void>;
  onDownload: (app: AppDetails) => Promise<string | null | undefined>;
  onToggleView: () => void;
  onSearchTextChange: (text: string) => void;
}

export function GridSearchView({
  apps,
  isLoading,
  error,
  searchText,
  totalResults,
  isFavorite,
  addFavorite,
  removeFavorite,
  onDownload,
  onToggleView,
  onSearchTextChange,
}: GridSearchViewProps) {
  return (
    <Grid
      isLoading={isLoading}
      searchBarPlaceholder="Search for iOS apps..."
      navigationTitle="Search iOS Apps"
      columns={5}
      fit={Grid.Fit.Fill}
      aspectRatio="1"
      onSearchTextChange={onSearchTextChange}
    >
      {/* Handle error state */}
      {error && <Grid.EmptyView title={error} icon={{ source: Icon.Warning }} />}

      {/* Handle empty results */}
      {!error && apps.length === 0 && searchText && (
        <Grid.EmptyView title="No results found" icon={{ source: Icon.MagnifyingGlass }} />
      )}

      {/* Show results when available */}
      {!error && apps.length > 0 && (
        <Grid.Section title={totalResults > 0 ? `Results (${totalResults})` : ""}>
          {apps.map((app) => {
            // Use highest quality artwork available for Grid view
            const iconUrl = app.artworkUrl512 || app.iconUrl || app.artworkUrl60;
            const isFavorited = isFavorite(app.bundleId);

            return (
              <Grid.Item
                key={app.bundleId}
                content={{
                  source: iconUrl || Icon.AppWindow,
                }}
                title={app.name}
                subtitle={`v${app.version}`}
                accessory={{
                  icon: { source: isFavorited ? Icon.Heart : Icon.HeartDisabled, tintColor: Color.Magenta },
                  tooltip: isFavorited ? "Favorited" : "Not Favorited",
                }}
                actions={
                  <ActionPanel>
                    <AppActionPanelContent
                      app={app}
                      onDownload={onDownload}
                      showViewDetails={true}
                      isFavorited={isFavorited}
                      onAddFavorite={addFavorite}
                      onRemoveFavorite={removeFavorite}
                    />
                    <ActionPanel.Section title="View">
                      <Action
                        title="Show List View"
                        icon={Icon.List}
                        onAction={onToggleView}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
                      />
                    </ActionPanel.Section>
                  </ActionPanel>
                }
              />
            );
          })}
        </Grid.Section>
      )}
    </Grid>
  );
}
