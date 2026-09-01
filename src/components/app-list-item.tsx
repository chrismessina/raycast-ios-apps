import { ComponentProps } from "react";
import { ActionPanel, Color, Icon, Image, List } from "@raycast/api";
import { AppDetails } from "../types";
import { renderStarRating } from "../utils/common";
import { formatDate, formatPrice } from "../utils/formatting";
import { AppActionPanelContent } from "./app-action-panel";

interface AppListItemProps {
  app: AppDetails;
  /** Secondary line: the developer in search, the genre inside a developer's catalog. */
  subtitle?: string;
  isFavorited: boolean;
  onDownload: (app: AppDetails) => Promise<string | null | undefined>;
  onAddFavorite: (app: AppDetails) => Promise<void>;
  onRemoveFavorite: (bundleId: string) => Promise<void>;
  /** Set false inside DeveloperAppsView, where the action would re-push the same view. */
  showDeveloperApps?: boolean;
  /**
   * Set false where the price would be read as a statement about a past
   * transaction. In Purchased Apps the only price available is the CURRENT
   * store price, so a title bought for $19.99 in 2008 and free today would
   * render "Free" in a list of things you paid for.
   */
  showPrice?: boolean;
  /**
   * Extra actions appended after the standard panel, e.g. a view-mode toggle.
   * Typed off ActionPanel rather than React.ReactNode: @raycast/api bundles its
   * own @types/react, and the two ReactNode types are not assignable.
   */
  children?: ComponentProps<typeof ActionPanel>["children"];
}

/**
 * One app row, shared by the search results and a developer's catalog.
 *
 * Both lists show the same five accessories in the same order and the same
 * action panel; only the subtitle and the trailing actions differ.
 */
export function AppListItem({
  app,
  subtitle,
  isFavorited,
  onDownload,
  onAddFavorite,
  onRemoveFavorite,
  showDeveloperApps = true,
  showPrice = true,
  children,
}: AppListItemProps) {
  const rating = app.averageUserRatingForCurrentVersion || app.averageUserRating;

  return (
    <List.Item
      title={app.name}
      subtitle={subtitle}
      icon={app.iconUrl ? { source: app.iconUrl, mask: Image.Mask.RoundedRectangle } : Icon.AppWindow}
      accessories={[
        { text: app.version },
        ...(showPrice ? [{ text: formatPrice(app.price, app.currency) }] : []),
        { text: formatDate(app.currentVersionReleaseDate || app.releaseDate) },
        { text: rating ? renderStarRating(rating) : "" },
        {
          icon: { source: isFavorited ? Icon.Heart : Icon.HeartDisabled, tintColor: Color.Magenta },
          tooltip: isFavorited ? "Favorited" : "Not Favorited",
        },
      ]}
      actions={
        <ActionPanel>
          <AppActionPanelContent
            app={app}
            onDownload={onDownload}
            showViewDetails={true}
            showDeveloperApps={showDeveloperApps}
            isFavorited={isFavorited}
            onAddFavorite={onAddFavorite}
            onRemoveFavorite={onRemoveFavorite}
          />
          {children}
        </ActionPanel>
      }
    />
  );
}
