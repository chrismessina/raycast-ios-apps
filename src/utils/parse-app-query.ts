// Interpret what the user typed in the search bar.
//
// The iTunes term-search index lags the App Store by hours-to-days, so a
// just-released app is findable by its exact ID long before its name returns
// anything. Recognising an App Store URL, a bare track ID, or a bundle ID lets
// the search fall through to the exact `lookup` endpoint instead.

export type AppQuery =
  // `fromUrl` marks a track ID the user pasted as a URL. A bare number the user
  // typed might just be a numeric app name, so an empty lookup should fall back
  // to term search — but term-searching a URL string is guaranteed noise, so a
  // URL-derived ID must not.
  | { kind: "trackId"; value: string; fromUrl: boolean }
  | { kind: "bundleId"; value: string }
  | { kind: "term"; value: string };

// Only Apple's own hosts can carry an App Store ID. Without this check
// `https://example.invalid/id6761221765` would resolve a real app.
const APP_STORE_HOSTS = new Set(["apps.apple.com", "itunes.apple.com"]);

// apps.apple.com/us/app/pocket-make-gizmos/id6761221765 (optionally ?i=123 for
// a sub-app, e.g. an iMessage or watch app link).
const APP_STORE_ID_PATTERN = /\/id(\d+)/;
const APP_STORE_SUB_ID_PATTERN = /[?&]i=(\d+)/;

// App Store track IDs have been 9-10 digits since the store opened (the
// earliest are in the 28xxxxxxx range). Anything shorter is far more likely a
// real search term ("1password", "24me") than an app ID.
const BARE_TRACK_ID_PATTERN = /^\d{9,10}$/;

// Reverse-DNS bundle identifier: at least two dot-separated segments, no spaces.
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/**
 * Pull the numeric ID out of any App Store URL (app or developer).
 *
 * Favorites and download history were persisted before `artistId` existed on
 * AppDetails, so their stored entries only carry `artistViewUrl` — this
 * recovers the developer ID from it.
 *
 * @param url An apps.apple.com URL, or undefined
 * @returns The ID as a number, or undefined when the URL carries none
 */
export function extractAppStoreId(url?: string): number | undefined {
  const id = url?.match(APP_STORE_ID_PATTERN)?.[1];
  return id ? Number(id) : undefined;
}

/**
 * Classify a raw search string.
 * @param raw Whatever the user typed
 * @returns The most specific interpretation that fits
 */
export function parseAppQuery(raw: string): AppQuery {
  const query = raw.trim();

  if (/^https?:\/\//i.test(query)) {
    let host: string | undefined;
    try {
      host = new URL(query).hostname.toLowerCase();
    } catch {
      // Not a parseable URL despite the scheme — fall through to term search.
    }

    if (host && APP_STORE_HOSTS.has(host)) {
      // A sub-app link (`?i=`) points at the item the user actually clicked, so
      // it wins over the `/id` path segment, which names the parent bundle.
      const subId = query.match(APP_STORE_SUB_ID_PATTERN)?.[1];
      const pathId = query.match(APP_STORE_ID_PATTERN)?.[1];
      const id = subId || pathId;
      if (id) {
        return { kind: "trackId", value: id, fromUrl: true };
      }
    }
  }

  if (BARE_TRACK_ID_PATTERN.test(query)) {
    return { kind: "trackId", value: query, fromUrl: false };
  }

  if (BUNDLE_ID_PATTERN.test(query)) {
    return { kind: "bundleId", value: query };
  }

  return { kind: "term", value: query };
}
