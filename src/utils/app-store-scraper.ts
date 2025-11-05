// App Store web scraper utility functions using Shoebox JSON method
import { AppDetails, PlatformType, ScreenshotInfo, PlatformPreferences } from "../types";
import { logger } from "@chrismessina/raycast-logger";
import { getPreferenceValues, showToast, Toast } from "@raycast/api";
import { APP_STORE_BASE_URL } from "./constants";
import { handleToolError } from "./error-handler";

// App Store constants (imported from centralized constants)

// App Store image resolution constants
const APP_STORE_IMAGE_RESOLUTIONS = {
  HIGHEST: "2000x0w", // Highest resolution typically available
  MEDIUM: "1000x0w", // Medium resolution
  LOW: "500x0w", // Lower resolution for bandwidth-constrained environments
};

// Platform-specific maximum resolutions based on Apple's CDN capabilities (as of 2025)
// These are the highest resolutions available for each platform's screenshots
const PLATFORM_MAX_RESOLUTIONS: Record<PlatformType, string> = {
  iPhone: "1290x0w", // Matches 6.7" iPhone screenshots
  iPad: "2048x0w", // Matches 12.9" iPad Pro screenshots
  Mac: "2560x0w", // Native macOS resolution; often retina
  AppleTV: "3840x0w", // Matches 4K Apple TV screenshots
  AppleWatch: "396x0w", // Matches Apple Watch Ultra screenshots
  VisionPro: "3840x0w", // Highest fidelity immersive images
};

/**
 * Transform mzstatic.com URLs to get the highest resolution PNG version
 * @param url Screenshot URL from the App Store
 * @param platformType Platform type to determine maximum resolution
 * @param resolution Optional target resolution override
 * @returns URL to the highest resolution PNG version
 */
export function getHighestResolutionUrl(url: string, platformType?: PlatformType, resolution?: string): string {
  try {
    // Only process mzstatic.com URLs or paths with thumb images
    if (url.includes("mzstatic.com/image/thumb/") || url.includes("image/thumb")) {
      // Determine the target resolution
      let targetResolution: string;

      if (resolution) {
        // Use explicit resolution override
        targetResolution = resolution;
      } else if (platformType && PLATFORM_MAX_RESOLUTIONS[platformType]) {
        // Use platform-specific maximum resolution
        targetResolution = PLATFORM_MAX_RESOLUTIONS[platformType];

        // Ensure minimum resolution of 2000x0w for platforms that support it
        // Only apply minimum for platforms that normally exceed 2000px width
        if (
          platformType === "iPad" ||
          platformType === "Mac" ||
          platformType === "AppleTV" ||
          platformType === "VisionPro"
        ) {
          const currentWidth = parseInt(targetResolution.split("x")[0]);
          if (currentWidth < 2000) {
            targetResolution = APP_STORE_IMAGE_RESOLUTIONS.HIGHEST; // 2000x0w
          }
        }
      } else {
        // Fallback to default highest resolution
        targetResolution = APP_STORE_IMAGE_RESOLUTIONS.HIGHEST;
      }

      // Detect the pattern .../{w}x{h}{c}.{f} (c can be empty or e.g. 'bb')
      const patternMatch = url.match(/\/([0-9]+)x([0-9]+)([a-z]*)\.([a-z]+)$/i);

      if (patternMatch) {
        // Extract the base part of the URL (before the resolution pattern)
        const basePart = url.substring(0, url.lastIndexOf("/") + 1);

        // Use target resolution with PNG format for highest quality
        return `${basePart}${targetResolution}.png`;
      }

      // Fallback to the original logic if no pattern is detected
      const basePart = url.substring(0, url.lastIndexOf("/") + 1);
      return `${basePart}${targetResolution}.png`;
    }

    logger.log(`[Scraper] URL not from mzstatic.com: ${url}`);
    return url;
  } catch (error) {
    logger.error("[Scraper] Error transforming URL:", error);
    return url;
  }
}

/**
 * Get enabled platforms from preferences
 * @returns Array of enabled platform types
 */
function getEnabledPlatforms(): PlatformType[] {
  try {
    const preferences = getPreferenceValues<PlatformPreferences>();
    const enabledPlatforms: PlatformType[] = [];

    if (preferences.includeIPhone) enabledPlatforms.push("iPhone");
    if (preferences.includeIPad) enabledPlatforms.push("iPad");
    if (preferences.includeMac) enabledPlatforms.push("Mac");
    if (preferences.includeAppleTV) enabledPlatforms.push("AppleTV");
    if (preferences.includeAppleWatch) enabledPlatforms.push("AppleWatch");
    if (preferences.includeVisionPro) enabledPlatforms.push("VisionPro");

    return enabledPlatforms;
  } catch (error) {
    logger.error("[Scraper] Error reading preferences, defaulting to all platforms:", error);
    // Default to all platforms if preferences can't be read
    return ["iPhone", "iPad", "Mac", "AppleTV", "AppleWatch", "VisionPro"];
  }
}

/**
 * Validate that at least one platform is enabled
 * @param platforms Array of enabled platforms
 * @returns True if at least one platform is enabled
 */
async function validateEnabledPlatforms(platforms: PlatformType[]): Promise<boolean> {
  if (platforms.length === 0) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Nothing to download!",
      message: "Enable at least one platform in Preferences to download screenshots.",
    });
    return false;
  }
  return true;
}

/**
 * Get the App Store URL for an app
 * @param app App details
 * @returns App Store URL
 */
export function getAppStoreUrl(app: AppDetails): string {
  // Use the trackViewUrl if available
  if (app.trackViewUrl) {
    return app.trackViewUrl;
  }

  // If we have an app ID, construct the URL with it
  if (app.id) {
    return `${APP_STORE_BASE_URL}/us/app/id${app.id}`;
  }

  // If we don't have an ID or trackViewUrl, use the bundleId to search
  // This creates a search URL that will redirect to the app if found
  const sanitizedName = app.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return `${APP_STORE_BASE_URL}/us/app/${sanitizedName}/id${app.bundleId}`;
}

/**
 * Scrape screenshots from the App Store using shoebox JSON extraction
 * @param app App details
 * @param platforms Optional platform override (falls back to preferences)
 * @returns Array of screenshot information objects
 */
export async function scrapeAppStoreScreenshots(
  app: AppDetails,
  platforms?: PlatformType[],
): Promise<ScreenshotInfo[]> {
  logger.log(`[Scraper] Scraping screenshots for ${app.name} (${app.bundleId})`);

  // Get enabled platforms from preferences or use override
  const enabledPlatforms = platforms || getEnabledPlatforms();

  // Validate that at least one platform is enabled
  if (!(await validateEnabledPlatforms(enabledPlatforms))) {
    return [];
  }

  logger.log(`[Scraper] Enabled platforms: ${enabledPlatforms.join(", ")}`);

  try {
    // Fetch the App Store page (base URL without platform-specific parameters)
    const baseUrl = getAppStoreUrl(app);
    logger.log(`[Scraper] Fetching App Store page: ${baseUrl}`);

    const response = await fetch(baseUrl);
    if (!response.ok) {
      await handleToolError(
        new Error(`Failed to fetch App Store page: ${response.status}`),
        "app-store-scraper",
        "Failed to fetch App Store page",
        false, // Don't throw, return empty array instead
      );
      return [];
    }

    const html = await response.text();

    // Extract screenshots from shoebox JSON
    const allScreenshots = extractScreenshotsFromShoeboxJson(html);
    logger.log(`[Scraper] Found ${allScreenshots.length} screenshots from base shoebox JSON`);

    // All screenshots are now extracted from the base shoebox JSON
    logger.log(
      `[Scraper] Extracted screenshots by platform: ${JSON.stringify(
        allScreenshots.reduce(
          (acc, s) => {
            acc[s.type] = (acc[s.type] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
      )}`,
    );

    // Filter by enabled platforms
    const filteredScreenshots = filterScreenshotsByPlatforms(allScreenshots, enabledPlatforms);

    // Remove duplicates
    const uniqueScreenshots = filterUniqueScreenshots(filteredScreenshots);

    logger.log(`[Scraper] Found ${uniqueScreenshots.length} total unique screenshots for enabled platforms`);

    return uniqueScreenshots;
  } catch (error) {
    logger.error("[Scraper] Error scraping screenshots:", error);
    return [];
  }
}

/**
 * Filter screenshots by enabled platforms
 * @param screenshots All screenshots
 * @param enabledPlatforms Enabled platform types
 * @returns Filtered screenshots
 */
export function filterScreenshotsByPlatforms(
  screenshots: ScreenshotInfo[],
  enabledPlatforms: PlatformType[],
): ScreenshotInfo[] {
  return screenshots.filter((screenshot) => enabledPlatforms.includes(screenshot.type));
}

/**
 * Filter out duplicate screenshots based on URL
 * Since Shoebox JSON provides clean data, we only need simple URL deduplication
 * @param screenshots Array of screenshot information objects
 * @returns Array of unique screenshot information objects
 */
function filterUniqueScreenshots(screenshots: ScreenshotInfo[]): ScreenshotInfo[] {
  const seen = new Set<string>();
  return screenshots.filter((screenshot) => {
    if (seen.has(screenshot.url)) {
      return false;
    }
    seen.add(screenshot.url);
    return true;
  });
}

/**
 * Screenshot artwork data from App Store serialized data
 */
interface ScreenshotArtwork {
  checksum: string | null;
  backgroundColor: unknown;
  textColor: unknown;
  style: string | null;
  crop: string;
  contentMode: string | null;
  imageScale: string | null;
  template: string; // URL template with {w}x{h}{c}.{f} placeholders
  width: number;
  height: number;
  variants: Array<{
    format: string;
    quality: number;
    supportsWideGamut: boolean;
  }>;
}

/**
 * Platform media item from App Store serialized data
 */
interface PlatformMediaItem {
  screenshot: ScreenshotArtwork;
}

/**
 * Platform media section from App Store serialized data
 */
interface PlatformMediaSection {
  items: PlatformMediaItem[];
  contentsMetadata?: unknown;
}

/**
 * Shelf mapping structure from App Store serialized data
 */
interface ShelfMapping {
  product_media_phone_?: PlatformMediaSection;
  product_media_pad_?: PlatformMediaSection;
  product_media_mac_?: PlatformMediaSection;
  product_media_vision_?: PlatformMediaSection;
  product_media_tv_?: PlatformMediaSection;
  product_media_watch_?: PlatformMediaSection;
  [key: string]: unknown;
}

/**
 * Build the highest resolution URL from a screenshot template
 * @param template URL template with placeholders like {w}x{h}{c}.{f}
 * @param width Original width
 * @param height Original height
 * @returns High resolution PNG URL
 */
function buildHighResolutionUrl(template: string, width: number, height: number): string {
  // Replace template placeholders with original dimensions and PNG format:
  // {w} = width, {h} = height, {c} = crop (bb = bounding box), {f} = format
  // We use the original dimensions provided by Apple, which are the highest quality available,
  // with "bb" for crop and "png" for the highest quality format
  return template.replace("{w}x{h}{c}.{f}", `${width}x${height}bb.png`);
}

/**
 * Extract screenshots from the serialized-server-data JSON in the App Store HTML
 *
 * This function parses the modern App Store web page structure that uses a JSON blob
 * embedded in a script tag with id="serialized-server-data". This replaces the old
 * "shoebox" JSON structure that Apple deprecated in their 2024 App Store redesign.
 *
 * The JSON contains platform-specific screenshot collections in the shelfMapping object:
 * - product_media_phone_ for iPhone screenshots
 * - product_media_pad_ for iPad screenshots
 * - product_media_mac_ for Mac screenshots
 * - product_media_vision_ for Vision Pro screenshots
 * - product_media_tv_ for Apple TV screenshots (if available)
 * - product_media_watch_ for Apple Watch screenshots (if available)
 *
 * Each screenshot includes a URL template with placeholders and original dimensions,
 * allowing us to construct the highest resolution URL available.
 *
 * ⚠️ IMPORTANT: Apple may change the App Store's internal structure at any time. This helper
 * is designed to fail gracefully if the structure changes, with comprehensive error handling
 * to minimize disruption.
 *
 * @param html App Store HTML content containing serialized-server-data JSON
 * @returns Array of screenshot information objects, empty array if parsing fails
 */
export function extractScreenshotsFromShoeboxJson(html: string): ScreenshotInfo[] {
  const screenshots: ScreenshotInfo[] = [];

  try {
    // STEP 1: Extract the serialized-server-data JSON from the HTML
    const serverDataRegex = /<script type="application\/json" id="serialized-server-data">([\s\S]*?)<\/script>/i;
    const serverDataMatch = html.match(serverDataRegex);

    if (!serverDataMatch || !serverDataMatch[1]) {
      logger.log(`[Scraper] No serialized-server-data JSON found in HTML`);
      return screenshots;
    }

    // STEP 2: Parse the JSON structure
    let serverData: Array<{ intent?: unknown; data?: { shelfMapping?: ShelfMapping } }>;
    try {
      const jsonContent = serverDataMatch[1].trim();
      serverData = JSON.parse(jsonContent);

      // Validate that we have a proper array
      if (!Array.isArray(serverData) || serverData.length === 0) {
        logger.log(`[Scraper] Invalid JSON data in serialized-server-data: not an array or empty`);
        return screenshots;
      }
    } catch (error) {
      logger.error(`[Scraper] Error parsing serialized-server-data JSON content:`, error);
      return screenshots;
    }

    // STEP 3: Extract shelf mapping with screenshot data
    const shelfMapping = serverData[0]?.data?.shelfMapping;
    if (!shelfMapping) {
      logger.log(`[Scraper] No shelfMapping found in serialized-server-data`);
      return screenshots;
    }

    // STEP 4: Define platform key to platform type mapping
    const platformKeyToPlatform: Record<string, PlatformType> = {
      product_media_phone_: "iPhone",
      product_media_pad_: "iPad",
      product_media_mac_: "Mac",
      product_media_vision_: "VisionPro",
      product_media_tv_: "AppleTV",
      product_media_watch_: "AppleWatch",
    };

    // STEP 5: Process each platform's screenshots
    let index = 0;
    for (const [platformKey, platformType] of Object.entries(platformKeyToPlatform)) {
      const platformMedia = shelfMapping[platformKey] as PlatformMediaSection | undefined;

      if (!platformMedia || !platformMedia.items || platformMedia.items.length === 0) {
        logger.log(`[Scraper] No screenshots found for ${platformType} (${platformKey})`);
        continue;
      }

      logger.log(`[Scraper] Processing ${platformMedia.items.length} screenshots for ${platformType}`);

      // Process each screenshot item
      for (const item of platformMedia.items) {
        if (!item.screenshot || !item.screenshot.template) {
          logger.log(`[Scraper] Skipping item with missing screenshot or template`);
          continue;
        }

        const artwork = item.screenshot;

        // Build the highest resolution URL from the template
        const highResUrl = buildHighResolutionUrl(artwork.template, artwork.width, artwork.height);

        screenshots.push({
          url: highResUrl,
          type: platformType,
          index: index++,
        });

        logger.log(
          `[Scraper] Added ${platformType} screenshot ${index}: ${artwork.width}x${artwork.height} -> ${highResUrl.substring(0, 100)}...`,
        );
      }
    }

    logger.log(`[Scraper] Extracted ${screenshots.length} screenshots from serialized-server-data JSON`);
  } catch (error) {
    logger.error(`[Scraper] Error parsing serialized-server-data JSON:`, error);
    // Return any screenshots we may have found before the error
    return screenshots;
  }

  return screenshots;
}
