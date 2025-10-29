import { ActionPanel, Action, Icon } from "@raycast/api";
import { AppDetails } from "../types";
import { AppActions } from "./app-actions";
import { CopyActions } from "./copy-actions";
import AppDetailView from "../views/app-detail-view";

interface AppActionPanelProps {
  app: AppDetails;
  onDownload?: (app: AppDetails) => Promise<string | null | undefined>;
  showViewDetails?: boolean;
  isFavorited?: boolean;
  onAddFavorite?: (app: AppDetails) => Promise<void>;
  onRemoveFavorite?: (bundleId: string) => Promise<void>;
}

/**
 * Core app actions (without ActionPanel wrapper)
 * Use this when you need to add these actions to an existing ActionPanel
 */
export function AppActionPanelContent({
  app,
  onDownload,
  showViewDetails = true,
  isFavorited,
  onAddFavorite,
  onRemoveFavorite,
}: AppActionPanelProps) {
  return (
    <>
      {showViewDetails && <Action.Push title="View Details" icon={Icon.Eye} target={<AppDetailView app={app} />} />}
      <AppActions
        app={app}
        onDownload={onDownload}
        isFavorited={isFavorited}
        onAddFavorite={onAddFavorite}
        onRemoveFavorite={onRemoveFavorite}
      />
      <CopyActions app={app} />
    </>
  );
}

/**
 * Complete ActionPanel with app actions
 * Use this as the main actions prop for list items
 */
export function AppActionPanel({
  app,
  onDownload,
  showViewDetails = true,
  isFavorited,
  onAddFavorite,
  onRemoveFavorite,
}: AppActionPanelProps) {
  return (
    <ActionPanel>
      <AppActionPanelContent
        app={app}
        onDownload={onDownload}
        showViewDetails={showViewDetails}
        isFavorited={isFavorited}
        onAddFavorite={onAddFavorite}
        onRemoveFavorite={onRemoveFavorite}
      />
    </ActionPanel>
  );
}
