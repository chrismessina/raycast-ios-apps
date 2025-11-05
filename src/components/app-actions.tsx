import { ActionPanel, Action, Icon, Keyboard } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { AppDetails } from "../types";
import { downloadScreenshots } from "../utils/screenshot-downloader";
import { getAppStoreUrl } from "../utils/constants";
import { useAppDownload } from "../hooks/use-app-download";
import { useAuthNavigation } from "../hooks/use-auth-navigation";
import { useFavoriteApps } from "../hooks/use-favorite-apps";
import { FavoriteActions } from "./favorite-actions";

interface AppActionsProps {
  app: AppDetails;
  onDownload?: (app: AppDetails) => Promise<string | null | undefined>;
  onDownloadScreenshots?: (app: AppDetails) => Promise<string | null | undefined>;
  isFavorited?: boolean;
  onAddFavorite?: (app: AppDetails) => Promise<void>;
  onRemoveFavorite?: (bundleId: string) => Promise<void>;
}

/**
 * Reusable component for app-related actions
 */
export function AppActions({
  app,
  onDownload,
  onDownloadScreenshots,
  isFavorited: isFavoritedProp,
  onAddFavorite,
  onRemoveFavorite,
}: AppActionsProps) {
  // Create a fallback App Store URL if trackViewUrl is not available
  const appStoreUrl = app.trackViewUrl || (app.id ? getAppStoreUrl(app.id) : undefined);

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

      // Fall back to auth-aware download via hook if no handler provided
      return await downloadWithAuth(app.bundleId, app.name, app.version, app.price);
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

  return (
    <ActionPanel.Section title="App Actions">
      <Action
        title="Download App"
        icon={Icon.Download}
        onAction={handleDownload}
        shortcut={{ modifiers: ["cmd"], key: "s" }}
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
        shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
      />
      {appStoreUrl && (
        <Action.OpenInBrowser
          title="View in App Store"
          icon={Icon.AppWindow}
          url={appStoreUrl}
          shortcut={Keyboard.Shortcut.Common.Open}
        />
      )}
      {app.artistViewUrl && <Action.OpenInBrowser title="View Developer" icon={Icon.Person} url={app.artistViewUrl} />}
    </ActionPanel.Section>
  );
}
