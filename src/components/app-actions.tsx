import { Action, ActionPanel, Icon, Keyboard } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { useAppDownload } from "../hooks/use-app-download";
import { useAuthNavigation } from "../hooks/use-auth-navigation";
import { useFavoriteApps } from "../hooks/use-favorite-apps";
import { AppDetails } from "../types";
import { getAppStoreUrl } from "../utils/constants";
import { downloadAppIcon } from "../utils/icon-downloader";
import { extractAppStoreId } from "../utils/parse-app-query";
import { downloadScreenshots } from "../utils/screenshot-downloader";
import { DeveloperAppsView } from "../views/developer-apps-view";
import { FavoriteActions } from "./favorite-actions";

interface AppActionsProps {
  app: AppDetails;
  onDownload?: (app: AppDetails) => Promise<string | null | undefined>;
  onDownloadScreenshots?: (app: AppDetails) => Promise<string | null | undefined>;
  onDownloadIcon?: (app: AppDetails) => Promise<string | null | undefined>;
  isFavorited?: boolean;
  onAddFavorite?: (app: AppDetails) => Promise<void>;
  onRemoveFavorite?: (bundleId: string) => Promise<void>;
  /** Set false inside DeveloperAppsView, where the action would re-push the same view. */
  showDeveloperApps?: boolean;
}

/**
 * Reusable component for app-related actions
 */
export function AppActions({
  app,
  onDownload,
  onDownloadScreenshots,
  onDownloadIcon,
  isFavorited: isFavoritedProp,
  onAddFavorite,
  onRemoveFavorite,
  showDeveloperApps = true,
}: AppActionsProps) {
  // Create a fallback App Store URL if trackViewUrl is not available
  const appStoreUrl = app.trackViewUrl || (app.id ? getAppStoreUrl(app.id) : undefined);

  // Favorites/history entries persisted before `artistId` existed still carry
  // the developer URL, so recover the ID from it rather than hiding the action.
  const artistId = app.artistId ?? extractAppStoreId(app.artistViewUrl);

  // Auth-aware download helpers
  const authNavigation = useAuthNavigation();
  const { downloadApp: downloadWithAuth } = useAppDownload(authNavigation);

  // Favorite management - use props if provided, otherwise use hook
  const { isFavorite, addFavorite, removeFavorite } = useFavoriteApps();
  const isFavorited = isFavoritedProp !== undefined ? isFavoritedProp : isFavorite(app.bundleId);
  const handleAddFavorite = onAddFavorite || addFavorite;
  const handleRemoveFavorite = onRemoveFavorite || removeFavorite;

  // Default download handler if none provided
  const handleDownload = async () => {
    try {
      if (onDownload) {
        return await onDownload(app);
      }

      // Fall back to auth-aware download via hook if no handler provided.
      // Pass app.fileSizeBytes and the full app (AppDetails) so the pre-release
      // gate, integrity check, and download-history recording all work — same
      // signature the other six call sites use.
      return await downloadWithAuth(
        app.bundleId,
        app.name,
        app.version,
        app.price,
        undefined,
        undefined,
        app.fileSizeBytes,
        app,
      );
    } catch (error) {
      console.error("Error downloading app:", error);
      showFailureToast({ title: "Error downloading app", message: String(error) });
      return null;
    }
  };

  const handleDownloadScreenshots = async () => {
    try {
      if (onDownloadScreenshots) {
        return await onDownloadScreenshots(app);
      }

      // Fall back to direct download if no handler provided
      return await downloadScreenshots(app.bundleId, app.name, app.version);
    } catch (error) {
      console.error("Error downloading screenshots:", error);
      showFailureToast({ title: "Error downloading screenshots", message: String(error) });
      return null;
    }
  };

  const handleDownloadIcon = async () => {
    try {
      if (onDownloadIcon) {
        return await onDownloadIcon(app);
      }

      // Fall back to direct download if no handler provided
      return await downloadAppIcon(app.bundleId, app.name, app.iconUrl);
    } catch (error) {
      console.error("Error downloading icon:", error);
      showFailureToast({ title: "Error downloading icon", message: String(error) });
      return null;
    }
  };

  return (
    <ActionPanel.Section title="App Actions">
      <Action
        title="Download App"
        icon={Icon.Download}
        onAction={handleDownload}
        shortcut={Keyboard.Shortcut.Common.Save}
      />
      <FavoriteActions
        app={app}
        isFavorited={isFavorited}
        onAddFavorite={handleAddFavorite}
        onRemoveFavorite={handleRemoveFavorite}
      />
      <Action
        title="Download Screenshots"
        icon={Icon.Image}
        onAction={handleDownloadScreenshots}
        shortcut={{ modifiers: ["cmd", "opt"], key: "s" }}
      />
      <Action
        title="Download App Icon"
        icon={Icon.AppWindowGrid3x3}
        onAction={handleDownloadIcon}
        shortcut={{ modifiers: ["cmd", "opt"], key: "i" }}
      />
      {appStoreUrl && (
        <Action.OpenInBrowser
          title="View in App Store"
          icon={Icon.AppWindow}
          url={appStoreUrl}
          shortcut={Keyboard.Shortcut.Common.Open}
        />
      )}
      {showDeveloperApps && artistId && (
        <Action.Push
          title={`View Apps by ${app.sellerName || app.artistName}`}
          icon={Icon.Person}
          target={<DeveloperAppsView artistId={artistId} developerName={app.sellerName || app.artistName} />}
          shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
        />
      )}
      {app.artistViewUrl && (
        <Action.OpenInBrowser title="View Developer in App Store" icon={Icon.Globe} url={app.artistViewUrl} />
      )}
    </ActionPanel.Section>
  );
}
