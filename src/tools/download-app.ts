import path from "path";
import { logger } from "@chrismessina/raycast-logger";
import { Clipboard, showInFinder, showToast, Toast, Tool } from "@raycast/api";
import { downloadApp, findExistingDownload, searchApps } from "../ipatool";
import {
  AppleAuthGateError,
  AppleEmptyResponseError,
  BuiltInAppError,
  Needs2FAError,
  NotYetReleasedError,
} from "../utils/auth";
import { DownloadPlatform } from "../utils/download-layout";
import { DownloadInProgressError } from "../utils/download-lock";
import { handleAppSearchError, handleDownloadError, handleIpatoolError, sanitizeQuery } from "../utils/error-handler";
import { analyzeIpatoolError } from "../utils/ipatool-error-patterns";

// Constants
const SEARCH_RESULT_LIMIT = 1;

// No initial confirmation - we'll confirm only during the actual download process

type Input = {
  /**
   * The name or search term for the iOS app
   */
  query: string;
};

/**
 * Download an iOS app by name or bundle ID
 */
export default async function downloadIosApp(input: Input) {
  logger.log(`[download-app tool] Starting download for app: "${sanitizeQuery(input.query)}"`);

  try {
    let bundleId = "";
    let appName = "";
    let appVersion = "";
    let price = "0";

    // Search for the app by name
    logger.log(`[download-app tool] Searching for app: "${sanitizeQuery(input.query)}"`);
    const searchResults = await searchApps(input.query, SEARCH_RESULT_LIMIT);

    if (searchResults.length === 0) {
      await handleAppSearchError(
        new Error(
          `No apps found matching "${sanitizeQuery(
            input.query,
          )}". Please try a different search term or check the exact app name.`,
        ),
        input.query,
        "download-app",
      );
      return { success: false, message: "No apps found" };
    }

    // Use the first result as the best match
    // The confirmation will show the user what will be downloaded
    const app = searchResults[0];
    bundleId = app.bundleId || app.bundleID || "";
    appName = app.name || "";
    appVersion = app.version || "";
    price = app.price ? app.price.toString() : "0";
    logger.log(`[download-app tool] Found app: ${appName} (${bundleId}) version ${appVersion}`);

    // Log if we're using a different app than what was searched for
    const queryLower = input.query.toLowerCase();
    if (appName.toLowerCase() !== queryLower) {
      logger.log(
        `[download-app tool] Note: Using closest match "${appName}" for search "${sanitizeQuery(input.query)}"`,
      );
    }

    // Download the app
    if (!bundleId) {
      await handleAppSearchError(
        new Error(`Could not determine bundle ID for "${sanitizeQuery(input.query)}"`),
        input.query,
        "download-app",
      );
      return { success: false, message: "Could not determine bundle ID" };
    }

    logger.log(`[download-app tool] Starting download for ${appName} (${bundleId})`);

    const platform = downloadPlatformFor(app.platforms);

    // Collision detection used to live ONLY in the UI hook, so this path walked
    // straight into `downloadApp`, whose completion handler unlinks whatever
    // sits at the destination before renaming. An AI download therefore
    // replaced an existing file silently, and the confirmation never said so.
    try {
      const existing = await findExistingDownload(bundleId, appName, appVersion, platform);
      if (existing) {
        const msg = `${appName} ${appVersion} is already downloaded at ${existing.filePath}. Delete it first to download again.`;
        logger.log(`[download-app tool] ${msg}`);
        await showToast({
          style: Toast.Style.Success,
          title: "Already Downloaded",
          message: existing.filePath,
          primaryAction: {
            title: "Show in Finder",
            shortcut: { modifiers: ["cmd"], key: "o" },
            onAction: async () => {
              await showInFinder(existing.filePath);
            },
          },
        });
        return { success: false, message: msg };
      }
    } catch (checkError) {
      // A failed check must not block the download; it only costs the prompt.
      logger.warn(`[download-app tool] Could not check for an existing download:`, checkError);
    }

    try {
      const filePath = await downloadApp(bundleId, appName, appVersion, price, 0, undefined, {
        platform,
      });

      if (filePath === null) {
        // Existing file found; skipped re-download. Validation flow already showed an informational toast.
        const msg = "App already exists and won't be  downloaded again.";
        logger.log(`[download-app tool] ${msg} (${appName} - ${bundleId})`);
        return { success: false, message: msg };
      }

      if (!filePath) {
        await handleDownloadError(
          new Error(
            `The app "${appName}" could not be downloaded. It may not be available in your region or may have been removed from the App Store.`,
          ),
          appName,
          "download-app",
        );
        return { success: false, message: "Download failed" };
      }

      // Verify file exists before reporting success (align with hook behavior)
      const fs = await import("fs");
      if (!fs.existsSync(filePath)) {
        await handleDownloadError(
          new Error(`File not found at expected path: ${filePath}`),
          "verify downloaded file",
          "download-app",
        );
        return { success: false, message: "Download failed" };
      }

      logger.log(`[download-app tool] Successfully downloaded app to: ${filePath}`);
      await showToast({
        style: Toast.Style.Success,
        title: "Download Complete",
        message: `${appName} saved to ${filePath}`,
        primaryAction: {
          title: "Show in Finder",
          shortcut: { modifiers: ["cmd"], key: "o" },
          onAction: async () => {
            await showInFinder(filePath);
          },
        },
        secondaryAction: {
          title: "Copy to Clipboard",
          shortcut: { modifiers: ["cmd"], key: "c" },
          onAction: async (toast) => {
            await Clipboard.copy(filePath);
            toast.message = "Path copied to clipboard";
          },
        },
      });

      return {
        filePath,
        fileName: path.basename(filePath),
        appName,
        bundleId,
        version: appVersion,
      };
    } catch (downloadError) {
      logger.error(`[download-app tool] Download error for "${appName}":`, downloadError);

      // A tool cannot push the code form, and Apple has already sent the code.
      // Run Doctor can take it.
      if (downloadError instanceof Needs2FAError) {
        return {
          success: false,
          message: `Apple sent a verification code to the user's devices. Ask them to enter it in the iOS Apps "Run Doctor" command, then try ${appName} again.`,
        };
      }

      if (downloadError instanceof DownloadInProgressError) {
        return { success: false, message: `${appName} is already being downloaded in another Raycast command.` };
      }

      // Pre-release / Coming Soon: detect via typed error first (carries the
      // classification through unchanged) and fall back to error-string
      // analysis in case the error bubbled up another path.
      if (downloadError instanceof AppleEmptyResponseError) {
        return { success: false, message: downloadError.message };
      }

      if (downloadError instanceof AppleAuthGateError) {
        return { success: false, message: downloadError.message };
      }

      if (downloadError instanceof BuiltInAppError) {
        return { success: false, message: downloadError.message };
      }

      if (downloadError instanceof NotYetReleasedError) {
        return { success: false, message: `${appName} isn't available for download yet (pre-release).` };
      }

      // Use the intelligent error handler which will detect auth errors and invalidate credentials
      await handleIpatoolError(downloadError, "download-app tool", undefined, "download", false);

      // Analyze error to determine the return message
      const errorMessage = downloadError instanceof Error ? downloadError.message : String(downloadError);
      const errorInfo = analyzeIpatoolError(errorMessage, undefined, "download");

      if (errorInfo.isAuthError) {
        return { success: false, message: "Authentication failed" };
      }

      if (errorInfo.errorType === "app_not_found") {
        return { success: false, message: "App not found" };
      }

      if (errorInfo.errorType === "not_yet_released") {
        return { success: false, message: `${appName} isn't available for download yet (pre-release).` };
      }

      return { success: false, message: "Download failed" };
    }
  } catch (error) {
    logger.error(`[download-app tool] Error:`, error);
    await handleDownloadError(
      error instanceof Error ? error : new Error(`Failed to download app: ${String(error)}`),
      "download app",
      "download-app",
    );
    return { success: false, message: "Download failed" };
  }
}

/**
 * Confirmation function to show the user what app will be downloaded
 */
export const confirmation: Tool.Confirmation<Input> = async (input) => {
  try {
    // Search for the app to show what will be downloaded
    const searchResults = await searchApps(input.query, 3);

    if (searchResults.length === 0) {
      // No confirmation needed if no apps found - the tool will handle the error
      return undefined;
    }

    const app = searchResults[0];
    const appName = app.name || "Unknown App";
    const developer = app.developer || "Unknown Developer";
    const version = app.version || "Unknown Version";
    const price = app.price ? `$${app.price}` : "Free";

    // Check if the match might not be exact
    const queryLower = input.query.toLowerCase();
    const appNameLower = appName.toLowerCase();
    const isExactMatch = appNameLower === queryLower; // Only consider exact matches

    let message = `Download "${appName}"?`;
    if (!isExactMatch) {
      message = `You searched for "${input.query}" but the closest match is "${appName}". Download this app?`;
    }

    return {
      message,
      info: [
        { name: "App Name", value: appName },
        { name: "Developer", value: developer },
        { name: "Version", value: version },
        { name: "Price", value: price },
      ],
    };
  } catch (error) {
    // If we can't search, let the main tool handle it
    logger.error(`[download-app confirmation] Error during confirmation:`, error);
    return undefined;
  }
};

/**
 * Pick the platform to download for from ipatool's `platforms` array.
 *
 * iPhone wins whenever it is offered, which keeps every universal app on the
 * path it has always taken. Only a title with no iPhone build at all — a
 * Mac-only app — is routed to macOS, and anything unrecognized falls back to
 * iPhone rather than guessing.
 */
function downloadPlatformFor(platforms?: string[]): DownloadPlatform {
  if (!platforms) return "iphone";
  // "No iPhone" does not mean "Mac-only". An array of ["ipad", "macos"] has a
  // perfectly good mobile build, and routing it to macOS made this path start
  // passing `--platform macos` where it previously passed no flag at all — so
  // the AI tool and the UI disagreed about the same app. Any mobile build wins
  // and keeps ipatool's own resolution; only a title with no mobile build at
  // all goes to macOS, and anything unrecognized falls back rather than guess.
  if (platforms.includes("iphone") || platforms.includes("ipad")) return "iphone";
  if (platforms.includes("macos")) return "macos";
  return "iphone";
}
