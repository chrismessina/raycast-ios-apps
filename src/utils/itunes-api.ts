// iTunes API utility functions
import { logger } from "@chrismessina/raycast-logger";
import { showFailureToast } from "@raycast/utils";
import { AppDetails, IpaToolSearchApp, ITunesResponse, ITunesResult } from "../types";
import { ITUNES_API_BASE_URL, ITUNES_LOOKUP_ENDPOINT, ITUNES_SEARCH_ENDPOINT } from "./constants";

// iTunes API Constants (imported from centralized constants)
const ITUNES_DEFAULT_COUNTRY = "us";
const ITUNES_SOFTWARE_ENTITY = "software";

// Rate limiting utilities
interface RateLimiter {
  lastRequest: number;
  minInterval: number;
}

const apiRateLimiter: RateLimiter = {
  lastRequest: 0,
  minInterval: 100, // 100ms between API requests
};

/**
 * Rate limit function calls
 */
async function rateLimit(limiter: RateLimiter): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - limiter.lastRequest;

  if (timeSinceLastRequest < limiter.minInterval) {
    const waitTime = limiter.minInterval - timeSinceLastRequest;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  limiter.lastRequest = Date.now();
}

// Retry tuning for the iTunes Search API. Apple's public endpoint
// intermittently returns transient 404/403/429/5xx responses for requests
// that succeed on the very next attempt, so a single attempt is not reliable.
const ITUNES_MAX_ATTEMPTS = 3;
const ITUNES_RETRY_BASE_DELAY_MS = 250;

/**
 * HTTP statuses that indicate a transient iTunes API failure worth retrying.
 * A genuine "no such app" is NOT in here: the search/lookup endpoints return
 * 200 with `resultCount: 0` for that case, so retrying a 404 never masks a
 * legitimately empty result — it only papers over Apple's flakiness.
 */
function isRetriableStatus(status: number): boolean {
  return status === 404 || status === 403 || status === 408 || status === 429 || status >= 500;
}

/**
 * Fetch a URL from the iTunes API with retry-and-backoff on transient failures.
 *
 * Retries on retriable HTTP statuses (see {@link isRetriableStatus}) and on
 * network-level errors (the fetch itself throwing). Exhausting all attempts
 * throws the last error so the caller's catch can surface a friendly message.
 *
 * @param url Fully-constructed request URL
 * @param context Short label for logging (e.g. the search term or bundleId)
 * @returns The successful Response
 */
async function fetchITunesWithRetry(url: string, context: string): Promise<Response> {
  let lastError: Error = new Error("iTunes API request failed");

  for (let attempt = 1; attempt <= ITUNES_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }

      lastError = new Error(`iTunes API returned ${response.status}: ${response.statusText}`);
      if (!isRetriableStatus(response.status) || attempt === ITUNES_MAX_ATTEMPTS) {
        throw lastError;
      }
      logger.log(
        `[iTunes API] Transient ${response.status} for ${context} (attempt ${attempt}/${ITUNES_MAX_ATTEMPTS}); retrying`,
      );
    } catch (error) {
      // A thrown non-retriable HTTP error (rethrown above) or a network error.
      lastError = error instanceof Error ? error : new Error(String(error));
      const isHttpError = lastError.message.startsWith("iTunes API returned ");
      const httpStatusIsTerminal =
        isHttpError && !isRetriableStatus(Number(lastError.message.match(/returned (\d+)/)?.[1] ?? 0));
      if (httpStatusIsTerminal || attempt === ITUNES_MAX_ATTEMPTS) {
        throw lastError;
      }
      logger.log(
        `[iTunes API] Network error for ${context} (attempt ${attempt}/${ITUNES_MAX_ATTEMPTS}): ${lastError.message}; retrying`,
      );
    }

    // Exponential backoff before the next attempt.
    const delay = ITUNES_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw lastError;
}

/**
 * Convert iTunes API result to AppDetails format
 * @param itunesData iTunes API result
 * @param baseDetails Optional base details to merge with
 * @returns Formatted AppDetails object
 */
export function convertITunesResultToAppDetails(
  itunesData: ITunesResult,
  baseDetails?: Partial<AppDetails>,
): AppDetails {
  // Start with base details or empty object
  const base = baseDetails || {};

  return {
    // Use base details as fallback
    id: itunesData.trackId?.toString() || base.id || "",
    name: itunesData.trackName || base.name || "",
    version: itunesData.version || base.version || "",
    bundleId: itunesData.bundleId || base.bundleId || "",
    description: itunesData.description || base.description || "",
    // iconUrl is the primary field for the best available icon (512 > 100 > 60)
    iconUrl: itunesData.artworkUrl512 || itunesData.artworkUrl100 || itunesData.artworkUrl60 || base.iconUrl || "",
    sellerName: itunesData.sellerName || base.sellerName || "Unknown Developer",
    artistName: itunesData.artistName || base.artistName || "",
    price: itunesData.price?.toString() || base.price || "0",
    currency: itunesData.currency || base.currency || "USD",
    genres: itunesData.genres && itunesData.genres.length > 0 ? itunesData.genres : base.genres || [],
    size: itunesData.fileSizeBytes?.toString() || base.size || "0",
    fileSizeBytes: itunesData.fileSizeBytes || (base.fileSizeBytes ?? 0),
    contentRating: itunesData.contentAdvisoryRating || base.contentRating || "",
    // Set the artwork URLs from iTunes API
    artworkUrl60: itunesData.artworkUrl60 || base.artworkUrl60 || "",
    artworkUrl512: itunesData.artworkUrl512 || base.artworkUrl512 || "",
    // Additional iTunes-specific fields
    averageUserRating: itunesData.averageUserRating || base.averageUserRating || 0,
    averageUserRatingForCurrentVersion:
      itunesData.averageUserRatingForCurrentVersion || base.averageUserRatingForCurrentVersion || 0,
    userRatingCount: itunesData.userRatingCount || base.userRatingCount || 0,
    userRatingCountForCurrentVersion:
      itunesData.userRatingCountForCurrentVersion || base.userRatingCountForCurrentVersion || 0,
    releaseDate: itunesData.releaseDate || base.releaseDate || "",
    currentVersionReleaseDate: itunesData.currentVersionReleaseDate || base.currentVersionReleaseDate,
    trackViewUrl: itunesData.trackViewUrl || base.trackViewUrl,
    artistId: itunesData.artistId || base.artistId,
    artistViewUrl: itunesData.artistViewUrl || base.artistViewUrl,
    // Screenshot URLs from iTunes API
    screenshotUrls: itunesData.screenshotUrls || base.screenshotUrls || [],
    ipadScreenshotUrls: itunesData.ipadScreenshotUrls || base.ipadScreenshotUrls || [],
    appletvScreenshotUrls: itunesData.appletvScreenshotUrls || base.appletvScreenshotUrls || [],
  };
}

/**
 * Convert ipatool search result to basic AppDetails format
 * @param app ipatool search app result
 * @returns Basic AppDetails object with default values
 */
export function convertIpaToolSearchAppToAppDetails(app: IpaToolSearchApp): AppDetails {
  return {
    id: app.id.toString(),
    name: app.name,
    version: app.version,
    bundleId: app.bundleId || app.bundleID || "",
    price: app.price.toString(),
    currency: "USD",
    artistName: app.developer,
    sellerName: app.developer,
    // Default empty values for fields not available from ipatool search
    artworkUrl60: "",
    artworkUrl512: "",
    description: "",
    iconUrl: "",
    genres: [],
    size: "0",
    fileSizeBytes: 0,
    contentRating: "",
    averageUserRating: 0,
    averageUserRatingForCurrentVersion: 0,
    userRatingCount: 0,
    userRatingCountForCurrentVersion: 0,
    releaseDate: "",
  };
}

/**
 * Fetch app details from iTunes Search API
 * @param bundleId Bundle ID of the app
 * @returns iTunes app details or null if not found
 */
export async function fetchITunesAppDetails(bundleId: string): Promise<ITunesResult | null> {
  try {
    // Apply rate limiting
    await rateLimit(apiRateLimiter);

    // Construct the iTunes API URL
    const url = new URL(ITUNES_API_BASE_URL + ITUNES_LOOKUP_ENDPOINT);
    url.searchParams.append("bundleId", bundleId);
    url.searchParams.append("country", ITUNES_DEFAULT_COUNTRY);
    url.searchParams.append("entity", ITUNES_SOFTWARE_ENTITY);

    logger.log(`[iTunes API] Fetching app details for ${bundleId} from ${url.toString()}`);

    // Fetch data from iTunes API with retry on transient failures
    const response = await fetchITunesWithRetry(url.toString(), bundleId);

    // Parse the response
    const data = (await response.json()) as ITunesResponse;

    // Check if we got any results
    if (data.resultCount === 0 || !data.results || data.results.length === 0) {
      logger.log(`[iTunes API] No results found for ${bundleId}`);
      return null;
    }

    // Return the first result
    return data.results[0];
  } catch (error) {
    console.error(`[iTunes API] Error fetching app details for ${bundleId} after retries:`, error);
    await showFailureToast(error, { title: "iTunes is temporarily unavailable", message: "Please try again." });
    return null;
  }
}

/**
 * Search for apps using iTunes Search API
 * @param term Search term
 * @param limit Maximum number of results to return
 * @param entity iTunes entity to scope the search to (platform filter). Defaults to iPhone/universal software.
 * @returns Array of iTunes search results
 */
export async function searchITunesApps(
  term: string,
  limit = 20,
  entity: string = ITUNES_SOFTWARE_ENTITY,
): Promise<ITunesResult[]> {
  try {
    // Apply rate limiting
    await rateLimit(apiRateLimiter);

    // Construct the iTunes API URL
    const url = new URL(ITUNES_API_BASE_URL + ITUNES_SEARCH_ENDPOINT);
    url.searchParams.append("term", term);
    url.searchParams.append("country", ITUNES_DEFAULT_COUNTRY);
    url.searchParams.append("entity", entity);
    url.searchParams.append("limit", limit.toString());

    logger.log(
      `[iTunes API] Searching for "${term}" with entity "${entity}" and limit ${limit} from ${url.toString()}`,
    );

    // Fetch data from iTunes API with retry on transient failures
    const response = await fetchITunesWithRetry(url.toString(), `"${term}"`);

    // Parse the response
    const data = (await response.json()) as ITunesResponse;

    // Check if we got any results
    if (data.resultCount === 0 || !data.results || data.results.length === 0) {
      logger.log(`[iTunes API] No results found for "${term}"`);
      return [];
    }

    // Return all results
    return data.results;
  } catch (error) {
    logger.error(`[iTunes API] Error searching for "${term}" after retries:`, error);
    await showFailureToast(error, { title: "iTunes is temporarily unavailable", message: "Please try again." });
    return [];
  }
}

/**
 * Enriches app details with data from iTunes API
 * @param app The app details to enrich
 * @returns Enriched app details
 */
export async function enrichAppDetails(app: AppDetails): Promise<AppDetails> {
  try {
    logger.log(`[iTunes API] Enriching app details for bundleId: ${app.bundleId}`);
    const itunesData = await fetchITunesAppDetails(app.bundleId);

    if (itunesData) {
      logger.log(`[iTunes API] Successfully retrieved iTunes data for ${app.bundleId}`);
      // Use the utility function to convert iTunes data to AppDetails
      return convertITunesResultToAppDetails(itunesData, app);
    }

    logger.log(`[iTunes API] No iTunes data found for ${app.bundleId}, using basic details only`);
    // If no iTunes data, ensure genres is at least an empty array and iconUrl is set
    return {
      ...app,
      genres: app.genres || [],
      sellerName: app.sellerName || "Unknown Developer",
      // Ensure iconUrl is set even if empty
      iconUrl: app.iconUrl || "",
    };
  } catch (error) {
    logger.error(`[iTunes API] Error enriching app details for ${app.bundleId}:`, error);
    return app; // Return the original app details if enrichment fails
  }
}

/**
 * Look up apps on the iTunes lookup endpoint.
 *
 * Unlike {@link searchITunesApps}, lookup is exact: it resolves an app by its
 * numeric App Store track ID (the `id` in an `apps.apple.com/.../id123` URL) or
 * every app belonging to a developer's artist ID. This is the path that finds
 * brand-new apps the term-search index has not picked up yet.
 *
 * Throws on a genuine API/network failure so callers can tell "this developer
 * has no apps" apart from "iTunes is unreachable" — an empty array means the
 * former and nothing else.
 *
 * @param params Lookup query params (e.g. `{ id: "6761221765" }`)
 * @param context Short label for logging
 * @returns Matching iTunes results (software entries only)
 * @throws When the lookup request fails after retries
 */
async function lookupITunes(params: Record<string, string>, context: string): Promise<ITunesResult[]> {
  await rateLimit(apiRateLimiter);

  const url = new URL(ITUNES_API_BASE_URL + ITUNES_LOOKUP_ENDPOINT);
  url.searchParams.append("country", ITUNES_DEFAULT_COUNTRY);
  url.searchParams.append("entity", ITUNES_SOFTWARE_ENTITY);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, value);
  }

  logger.log(`[iTunes API] Looking up ${context} from ${url.toString()}`);

  const response = await fetchITunesWithRetry(url.toString(), context);
  const data = (await response.json()) as ITunesResponse;

  if (data.resultCount === 0 || !data.results?.length) {
    logger.log(`[iTunes API] No results found for ${context}`);
    return [];
  }

  // A developer lookup returns the artist record alongside their apps; only
  // software entries can be converted to AppDetails.
  const software = data.results.filter((result) => result.wrapperType === "software");
  logger.log(
    `[iTunes API] Lookup for ${context} returned ${data.resultCount} record(s), ${software.length} of them apps`,
  );
  return software;
}

/**
 * Look up many apps at once by their numeric App Store track IDs.
 *
 * The lookup endpoint accepts a comma-separated `id` list, so a whole page of
 * purchases is enriched in ONE request instead of N. Apple caps the list, so
 * callers are chunked at {@link ITUNES_LOOKUP_ID_CHUNK}.
 *
 * Results come back in Apple's order and may be shorter than the input: a
 * delisted app returns nothing at all. Callers must key off the returned
 * trackId rather than assuming positional correspondence — a third of a long
 * purchase history is typically missing from the Store.
 *
 * @param trackIds App Store track IDs to look up
 * @returns The apps Apple still lists, keyed by trackId
 */
export async function lookupITunesAppsByIds(trackIds: Array<number | string>): Promise<Map<number, ITunesResult>> {
  const found = new Map<number, ITunesResult>();
  if (trackIds.length === 0) {
    return found;
  }

  for (let i = 0; i < trackIds.length; i += ITUNES_LOOKUP_ID_CHUNK) {
    const chunk = trackIds.slice(i, i + ITUNES_LOOKUP_ID_CHUNK);
    const results = await lookupITunes({ id: chunk.join(",") }, `${chunk.length} app id(s)`);
    for (const result of results) {
      if (result.trackId) {
        found.set(result.trackId, result);
      }
    }
  }

  logger.log(`[iTunes API] Batch lookup matched ${found.size} of ${trackIds.length} requested id(s)`);
  return found;
}

/**
 * Look up a single app by its numeric App Store track ID.
 * @param trackId App Store track ID (digits only)
 * @returns The app, or null when no app carries that ID
 */
export async function lookupITunesAppById(trackId: string): Promise<ITunesResult | null> {
  const results = await lookupITunes({ id: trackId }, `app id ${trackId}`);
  return results[0] ?? null;
}

/**
 * Hard cap on a developer lookup. Apple's lookup endpoint accepts at most 200
 * results, so a prolific developer's tail is not reachable this way — callers
 * must say so rather than presenting a truncated list as complete.
 */
export const ARTIST_LOOKUP_LIMIT = 200;

/**
 * Track IDs per batch lookup request. Apple accepts a comma-separated `id`
 * list; 190 keeps the URL clear of length limits while staying near the cap.
 */
const ITUNES_LOOKUP_ID_CHUNK = 190;

/**
 * Look up every app published by a developer.
 * @param artistId iTunes artist (developer) ID
 * @param limit Maximum number of apps to return
 * @returns The developer's apps, most-rated first
 */
export async function lookupITunesAppsByArtist(
  artistId: number | string,
  artistLimit = ARTIST_LOOKUP_LIMIT,
): Promise<ITunesResult[]> {
  const results = await lookupITunes(
    { id: artistId.toString(), limit: artistLimit.toString() },
    `developer ${artistId}`,
  );
  return results.sort((a, b) => (b.userRatingCount ?? 0) - (a.userRatingCount ?? 0));
}
