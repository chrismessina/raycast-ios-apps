import { logger } from "@chrismessina/raycast-logger";
import { useMemo, useRef, useState } from "react";
import { Clipboard, Keyboard, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { listPurchases, PURCHASES_PAGE_SIZE } from "../ipatool";
import type { AppDetails, IpaToolPurchasedApp } from "../types";
import { convertITunesResultToAppDetails, lookupITunesAppsByIds } from "../utils/itunes-api";

export type PurchasesSortKey = "date-desc" | "date-asc" | "name-asc" | "name-desc";

/**
 * The order pages are pulled from ipatool in. Both name sorts ride the natural
 * (newest-first) traversal — they reorder what is already loaded, so they must
 * not throw away loaded pages by changing the fetch direction.
 */
type FetchDirection = "newest" | "oldest";

export interface PurchasedApp {
  app: AppDetails;
  /** ISO 8601 date this Apple ID acquired the app. */
  purchaseDate: string;
  /** False when Apple no longer lists the app: the row is ipatool data only. */
  isListed: boolean;
}

function fetchDirectionFor(sortKey: PurchasesSortKey): FetchDirection {
  return sortKey === "date-asc" ? "oldest" : "newest";
}

/** Last 1-indexed ipatool page for a library of `totalCount` purchases. */
function lastPageFor(totalCount: number): number {
  return Math.max(1, Math.ceil(totalCount / PURCHASES_PAGE_SIZE));
}

/**
 * The shape of an app before iTunes has said anything about it. Everything
 * iTunes owns is left empty rather than guessed — notably `price`, which is 0
 * on every purchase record regardless of what was paid.
 */
function baseFromPurchase(record: IpaToolPurchasedApp): AppDetails {
  return {
    id: record.id.toString(),
    bundleId: record.bundleID,
    name: record.name,
    version: record.version,
    price: "",
    currency: "",
    artistName: "",
    sellerName: "",
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
 * Drop the two fields no list row renders. A Raycast command gets a 100 MB
 * heap and this list can reach several thousand rows; the detail view
 * re-enriches through `useAppDetails`, so nothing is lost.
 */
function withoutDetailPayload(app: AppDetails): AppDetails {
  return { ...app, description: "", screenshotUrls: [], ipadScreenshotUrls: [], appletvScreenshotUrls: [] };
}

/** One batched iTunes lookup per page. Delisted apps simply come back missing. */
async function enrichPage(records: IpaToolPurchasedApp[]): Promise<PurchasedApp[]> {
  const listed = await lookupITunesAppsByIds(records.map((record) => record.id));
  logger.log(`[purchases] Enrichment hit rate: ${listed.size}/${records.length} still listed on the App Store`);

  return records.map((record) => {
    const base = baseFromPurchase(record);
    const result = listed.get(record.id);
    return {
      app: result ? withoutDetailPayload(convertITunesResultToAppDetails(result, base)) : base,
      purchaseDate: record.purchaseDate,
      isListed: Boolean(result),
    };
  });
}

/**
 * The signed-in Apple ID's purchases, paged by Raycast's own infinite scroll.
 *
 * ipatool only ever returns purchase-date-descending pages, so oldest-first is
 * served by walking the pages backwards and reversing each one. Name sorts
 * cannot be done server-side without pulling the whole library (~7-10 s per
 * 100 apps), so they reorder the loaded rows only — the caller must say so.
 */
export function usePurchasedApps(sortKey: PurchasesSortKey, enabled = true) {
  const [totalCount, setTotalCount] = useState(0);
  // Survives across pages so oldest-first only has to learn the page count once.
  const totalCountRef = useRef<number | null>(null);
  // Concurrent oldest-first pages would otherwise each fire their own probe.
  const probeRef = useRef<Promise<number> | null>(null);
  // Bumped by refresh(). A request that started before a refresh must not write
  // its now-stale count back after the refresh cleared it — ipatool requests are
  // not abortable, so the old one WILL finish and try.
  const generationRef = useRef(0);
  const direction = fetchDirectionFor(sortKey);

  const { isLoading, data, pagination, error, revalidate } = useCachedPromise(
    (dir: FetchDirection) =>
      async (options: { page: number }): Promise<{ data: PurchasedApp[]; hasMore: boolean }> => {
        const generation = generationRef.current;
        const isCurrent = () => generation === generationRef.current;
        // Each page is 7-10 s of ipatool; say so before the wait, not after.
        const toast = await showToast({
          style: Toast.Style.Animated,
          title: "Loading purchases…",
          message: `Page ${options.page + 1}`,
        });

        try {
          let ipatoolPage: number;

          if (dir === "newest") {
            // Raycast pages are 0-indexed, ipatool pages are 1-indexed.
            ipatoolPage = options.page + 1;
          } else {
            if (totalCountRef.current === null) {
              // Cheapest possible probe for the page count: one record. Shared
              // so simultaneous pages await one request instead of racing.
              if (probeRef.current === null) {
                const probe = listPurchases(1, 1).then((result) => result.totalCount);
                probeRef.current = probe;
                // Clear only if it is still OURS — an unconditional null here
                // wipes a newer refresh's probe and makes the next page probe
                // again against a half-reset cache.
                probe.finally(() => {
                  if (probeRef.current === probe) {
                    probeRef.current = null;
                  }
                });
              }
              const probed = await probeRef.current;
              if (!isCurrent()) {
                logger.log("[purchases] Discarding probe result from a superseded refresh generation");
                await toast.hide();
                return { data: [], hasMore: false };
              }
              totalCountRef.current = probed;
              setTotalCount(probed);
            }
            ipatoolPage = lastPageFor(totalCountRef.current) - options.page;
            if (ipatoolPage < 1) {
              await toast.hide();
              return { data: [], hasMore: false };
            }
          }

          logger.log(
            `[purchases] ipatool list-purchases -p ${ipatoolPage} -l ${PURCHASES_PAGE_SIZE} (Raycast page ${options.page}, order: ${dir}) — starting`,
          );
          const ipatoolStartedAt = Date.now();
          const response = await listPurchases(ipatoolPage);
          logger.log(
            `[purchases] ipatool page ${ipatoolPage} returned ${response.apps.length} of ${response.totalCount} in ${Date.now() - ipatoolStartedAt}ms`,
          );
          if (isCurrent()) {
            totalCountRef.current = response.totalCount;
            setTotalCount(response.totalCount);
          } else {
            logger.log(`[purchases] Not writing page ${ipatoolPage}'s count — a refresh superseded this request`);
          }

          // The final page of an oldest-first walk is the partial one, and it
          // is the first page fetched.
          const records = dir === "oldest" ? [...response.apps].reverse() : response.apps;
          const enrichStartedAt = Date.now();
          const rows = await enrichPage(records);
          logger.log(`[purchases] Enriched ${rows.length} row(s) in ${Date.now() - enrichStartedAt}ms`);
          const hasMore = dir === "oldest" ? ipatoolPage > 1 : ipatoolPage * PURCHASES_PAGE_SIZE < response.totalCount;

          logger.log(
            `[purchases] Page ${options.page} complete in ${Date.now() - ipatoolStartedAt}ms — hasMore=${hasMore}`,
          );
          await toast.hide();
          return { data: rows, hasMore };
        } catch (fetchError) {
          await toast.hide();
          throw fetchError;
        }
      },
    [direction],
    {
      keepPreviousData: true,
      // The caller's sticky sort arrives from LocalStorage a tick late; firing
      // before it lands burns a 7-10 s page in the wrong direction.
      execute: enabled,
      onError: async (fetchError) => {
        logger.error("[purchases] Page fetch failed", fetchError);
        const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
        await showToast({
          style: Toast.Style.Failure,
          title: "Couldn't load purchases",
          message,
          primaryAction: {
            title: "Copy Error",
            shortcut: Keyboard.Shortcut.Common.Copy,
            onAction: () => {
              Clipboard.copy(message);
            },
          },
        });
      },
    },
  );

  const apps = useMemo(() => {
    const loaded = data ?? [];
    if (sortKey === "name-asc") {
      return [...loaded].sort((a, b) => a.app.name.localeCompare(b.app.name));
    }
    if (sortKey === "name-desc") {
      return [...loaded].sort((a, b) => b.app.name.localeCompare(a.app.name));
    }
    return loaded;
  }, [data, sortKey]);

  /**
   * Refresh, forgetting the cached library size first.
   *
   * Oldest-first derives its page number from `lastPageFor(totalCount)`. If the
   * library grew past a 100-item boundary since the count was cached, that
   * arithmetic keeps pointing at the OLD last page and the genuinely-oldest new
   * page is never requested. Re-probe rather than trust the stale count.
   */
  const refresh = () => {
    logger.log("[purchases] Refresh requested; clearing cached library size before revalidating");
    generationRef.current += 1;
    totalCountRef.current = null;
    probeRef.current = null;
    revalidate();
  };

  return {
    apps,
    isLoading,
    error,
    pagination,
    revalidate: refresh,
    totalCount,
    loadedCount: data?.length ?? 0,
  };
}
