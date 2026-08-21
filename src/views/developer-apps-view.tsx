import { logger } from "@chrismessina/raycast-logger";
import { useEffect, useState } from "react";
import { Icon, List } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { AppListItem } from "../components/app-list-item";
import { useAppDownload, useFavoriteApps } from "../hooks";
import { useAuthNavigation } from "../hooks/use-auth-navigation";
import { AppDetails } from "../types";
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

  const handleDownload = (app: AppDetails) =>
    downloadApp(app.bundleId, app.name, app.version, app.price, undefined, undefined, app.fileSizeBytes, app);

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
        {apps.map((app) => (
          <AppListItem
            key={app.bundleId || app.id}
            app={app}
            subtitle={app.genres?.[0]}
            isFavorited={isFavorite(app.bundleId)}
            onDownload={handleDownload}
            onAddFavorite={addFavorite}
            onRemoveFavorite={removeFavorite}
            // We are already inside this developer's catalog; the action would
            // only push an identical view onto the stack.
            showDeveloperApps={false}
          />
        ))}
      </List.Section>
    </List>
  );
}

export default DeveloperAppsView;
