// Displays comprehensive information about an iOS app with metadata and actions
import { Detail } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { AppDetails } from "../types";
import { AppActionPanel } from "../components/app-action-panel";
import { AppDetailContent } from "../components/app-detail-content";
import { useAppDetails, useAppDownload, useFavoriteApps } from "../hooks";
import { logger } from "@chrismessina/raycast-logger";
import { useAuthNavigation } from "../hooks/use-auth-navigation";

interface AppDetailViewProps {
  app: AppDetails;
}

export default function AppDetailView({ app: initialApp }: AppDetailViewProps) {
  // Use the custom hooks
  const { app, isLoading } = useAppDetails(initialApp);
  const authNavigation = useAuthNavigation();
  const { downloadApp } = useAppDownload(authNavigation);
  const { isFavorite, addFavorite, removeFavorite } = useFavoriteApps();
  const isFavorited = isFavorite(app.bundleId);

  logger.log(`[AppDetailView] Rendering app: ${app.name}, version: ${app.version}, bundleId: ${app.bundleId}`);

  // Get the shared detail content
  const { markdown, metadata } = AppDetailContent({ app, isFavorited });

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={app.name}
      markdown={markdown}
      metadata={metadata}
      actions={
        <AppActionPanel
          app={app}
          onDownload={() => {
            if (!app.bundleId) {
              showFailureToast(new Error("Bundle ID is missing"), { title: "Cannot download app" });
              return Promise.resolve(null);
            }
            return downloadApp(app.bundleId, app.name, app.version, app.price, true, undefined, app.fileSizeBytes);
          }}
          showViewDetails={false}
          isFavorited={isFavorited}
          onAddFavorite={addFavorite}
          onRemoveFavorite={removeFavorite}
        />
      }
    />
  );
}
