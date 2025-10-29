import { Icon, List, ActionPanel, Action } from "@raycast/api";
import { formatPrice } from "./utils/formatting";
import { renderStarRating } from "./utils/common";
import { AppActionPanelContent } from "./components/app-action-panel";
import { ExportActions } from "./components/export-actions";
import { useAppDownload, useFavoriteApps } from "./hooks";
import { useAuthNavigation } from "./hooks/use-auth-navigation";

export default function Favorites() {
  const authNavigation = useAuthNavigation();
  const { downloadApp } = useAppDownload(authNavigation);
  const { favoriteApps, clearFavorites, isLoading, addFavorite, removeFavorite } = useFavoriteApps();

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search favorite apps..."
      actions={
        favoriteApps.length > 0 ? (
          <ActionPanel>
            <ExportActions />
            <ActionPanel.Section>
              <Action
                title="Clear All Favorites"
                onAction={clearFavorites}
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={{ modifiers: ["cmd", "shift"], key: "delete" }}
              />
            </ActionPanel.Section>
          </ActionPanel>
        ) : undefined
      }
    >
      {favoriteApps.length === 0 && !isLoading && (
        <List.EmptyView
          title="No Favorite Apps"
          description="Apps you add to favorites will appear here for quick access."
          icon={Icon.Heart}
        />
      )}

      {favoriteApps.map((item, index) => {
        const app = item.app;
        const rating = app.averageUserRatingForCurrentVersion || app.averageUserRating;
        const ratingText = rating ? renderStarRating(rating) : "";
        const iconUrl = app.artworkUrl60 || app.artworkUrl512 || app.iconUrl;

        return (
          <List.Item
            key={`${app.bundleId}-${index}`}
            title={app.name}
            subtitle={app.sellerName}
            accessories={[{ text: app.version }, { text: formatPrice(app.price, app.currency) }, { text: ratingText }]}
            icon={iconUrl ? { source: iconUrl } : Icon.AppWindow}
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
                  isFavorited={true}
                  onAddFavorite={addFavorite}
                  onRemoveFavorite={removeFavorite}
                />
                <ExportActions />
                <ActionPanel.Section>
                  <Action
                    title="Clear All Favorites"
                    onAction={clearFavorites}
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "delete" }}
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
