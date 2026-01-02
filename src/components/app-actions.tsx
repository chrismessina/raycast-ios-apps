import { ActionPanel, Action, Icon, Keyboard, Clipboard, showToast, Toast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { AppDetails } from "../types";
import { downloadScreenshots } from "../utils/screenshot-downloader";
import { downloadAppIcon } from "../utils/icon-downloader";
import { getAppStoreUrl } from "../utils/constants";
import { useAppDownload } from "../hooks/use-app-download";
import { useAuthNavigation } from "../hooks/use-auth-navigation";
import { useFavoriteApps } from "../hooks/use-favorite-apps";
import { FavoriteActions } from "./favorite-actions";
import { getAppMarkdown } from "./app-detail-content";

interface AppActionsProps {
  app: AppDetails;
  onDownload?: (app: AppDetails) => Promise<string | null | undefined>;
  onDownloadScreenshots?: (app: AppDetails) => Promise<string | null | undefined>;
  onDownloadIcon?: (app: AppDetails) => Promise<string | null | undefined>;
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
  onDownloadIcon,
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

  const handleCopyDescriptionMarkdown = async () => {
    try {
      const markdown = getAppMarkdown(app, isFavorited);
      await Clipboard.copy(markdown);
      await showToast(Toast.Style.Success, "Copied Description as Markdown");
    } catch (error) {
      showFailureToast({ title: "Error copying description", message: String(error) });
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
        title="Copy Description as Markdown"
        icon={Icon.QuoteBlock}
        onAction={handleCopyDescriptionMarkdown}
        shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
      />
      <Action
        title="Download Screenshots"
        icon={Icon.Image}
        onAction={handleDownloadScreenshots}
        shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
      />
      <Action
        title="Download App Icon"
        icon={Icon.AppWindowGrid3x3}
        onAction={handleDownloadIcon}
        shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
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
