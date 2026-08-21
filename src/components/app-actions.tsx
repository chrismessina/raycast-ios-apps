import { Action, ActionPanel, Icon, Keyboard } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { AppDetails } from "../types";
import { getAppStoreUrl } from "../utils/constants";
import { downloadAppIcon } from "../utils/icon-downloader";
import { extractAppStoreId } from "../utils/parse-app-query";
import { downloadScreenshots } from "../utils/screenshot-downloader";
import { DeveloperAppsView } from "../views/developer-apps-view";
import { FavoriteActions } from "./favorite-actions";

// Download and favorite state are REQUIRED, not optional with a hook fallback.
// AppActions renders once per list item, so a `useFavoriteApps()` fallback in
// here meant every visible row independently read and parsed the whole
// favorites blob from LocalStorage and retained its own copy — N duplicate
// copies of the same data inside a 100 MB heap. Every call site already owns
// this state; make it pass it down.
interface AppActionsProps {
  app: AppDetails;
  onDownload: (app: AppDetails) => Promise<string | null | undefined>;
  onDownloadScreenshots?: (app: AppDetails) => Promise<string | null | undefined>;
  onDownloadIcon?: (app: AppDetails) => Promise<string | null | undefined>;
  isFavorited: boolean;
  onAddFavorite: (app: AppDetails) => Promise<void>;
  onRemoveFavorite: (bundleId: string) => Promise<void>;
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
  isFavorited,
  onAddFavorite,
  onRemoveFavorite,
  showDeveloperApps = true,
}: AppActionsProps) {
  // Create a fallback App Store URL if trackViewUrl is not available
  const appStoreUrl = app.trackViewUrl || (app.id ? getAppStoreUrl(app.id) : undefined);

  // Favorites/history entries persisted before `artistId` existed still carry
  // the developer URL, so recover the ID from it rather than hiding the action.
  const artistId = app.artistId ?? extractAppStoreId(app.artistViewUrl);

  const handleDownload = async () => {
    try {
      return await onDownload(app);
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
        onAddFavorite={onAddFavorite}
        onRemoveFavorite={onRemoveFavorite}
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
