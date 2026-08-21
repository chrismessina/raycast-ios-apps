import { logger } from "@chrismessina/raycast-logger";
import { useEffect, useState } from "react";
import { ActionPanel, Color, Icon, Image, List } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { AppActionPanelContent } from "../components/app-action-panel";
import { useAppDownload, useFavoriteApps } from "../hooks";
import { useAuthNavigation } from "../hooks/use-auth-navigation";
import { AppDetails } from "../types";
import { renderStarRating } from "../utils/common";
import { formatDate, formatPrice } from "../utils/formatting";
import { ARTIST_LOOKUP_LIMIT, convertITunesResultToAppDetails, lookupITunesAppsByArtist } from "../utils/itunes-api";

interface DeveloperAppsViewProps {
  artistId: number;
  developerName: string;
}

/**
 * All apps published by one developer, resolved from the iTunes artist lookup.
 * Pushed from an app's action panel so the developer's catalog stays inside
 * Raycast instead of handing off to the browser.
 */
export function DeveloperAppsView({ artistId, developerName }: DeveloperAppsViewProps) {
  const [apps, setApps] = useState<AppDetails[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const authNavigation = useAuthNavigation();
  const { downloadApp } = useAppDownload(authNavigation);
  const { isFavorite, addFavorite, removeFavorite } = useFavoriteApps();

  useEffect(() => {
    let cancelled = false;

    async function loadDeveloperApps() {
      try {
        logger.log(`[Developer] Looking up apps by "${developerName}" (artistId ${artistId})`);
        const results = await lookupITunesAppsByArtist(artistId);
        logger.log(`[Developer] "${developerName}" (artistId ${artistId}) has ${results.length} app(s)`);
        if (!cancelled) {
          setApps(results.map((result) => convertITunesResultToAppDetails(result)));
        }
      } catch (err) {
        // The lookup throws on a real API/network failure. Without this branch
        // the view would render "no apps found", which is a different — and
        // wrong — thing to tell the user.
        logger.error(`[Developer] Failed to load apps for artistId ${artistId}:`, err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          await showFailureToast(err, { title: `Could not load apps by ${developerName}` });
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadDeveloperApps();
    return () => {
      cancelled = true;
    };
  }, [artistId, developerName]);

  // Apple's lookup endpoint caps out; say so rather than presenting a truncated
  // catalog as the developer's complete one.
  const isTruncated = apps.length >= ARTIST_LOOKUP_LIMIT;
  const sectionTitle = isTruncated ? `First ${ARTIST_LOOKUP_LIMIT} Apps` : `Apps (${apps.length})`;

  return (
    <List
      isLoading={isLoading}
      navigationTitle={developerName}
      searchBarPlaceholder={`Filter apps by ${developerName}...`}
    >
      <List.EmptyView
        title={error ? "Could Not Load Apps" : isLoading ? "Loading Apps…" : `No Apps Found for ${developerName}`}
        description={
          error ??
          (isLoading ? undefined : "Apple's developer lookup returned no apps for this developer in the US store.")
        }
        icon={error ? Icon.Warning : Icon.Person}
      />
      <List.Section title={apps.length > 0 ? sectionTitle : ""}>
        {apps.map((app) => {
          const rating = app.averageUserRatingForCurrentVersion || app.averageUserRating;
          const isFavorited = isFavorite(app.bundleId);

          return (
            <List.Item
              key={app.bundleId || app.id}
              title={app.name}
              subtitle={app.genres?.[0]}
              icon={app.iconUrl ? { source: app.iconUrl, mask: Image.Mask.RoundedRectangle } : Icon.AppWindow}
              accessories={[
                { text: app.version },
                { text: formatPrice(app.price, app.currency) },
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
                    // We are already inside this developer's catalog; the action
                    // would only push an identical view onto the stack.
                    showDeveloperApps={false}
                    isFavorited={isFavorited}
                    onAddFavorite={addFavorite}
                    onRemoveFavorite={removeFavorite}
                  />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}

export default DeveloperAppsView;
