// Icon downloader utility functions
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { showFailureToast } from "@raycast/utils";
import { showToast, Toast, showHUD, Clipboard, showInFinder } from "@raycast/api";
// AppDetails type available if needed for future enhancements
import { getDownloadsDirectory, validateSafePath, sanitizeFilename } from "./paths";
import { logger } from "@chrismessina/raycast-logger";
import { getConfigValue } from "../config";

// Promisify fs functions
const writeFileAsync = promisify(fs.writeFile);

// Configuration constants
const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 30;
const MAX_ICON_SIZE = 1024; // Maximum icon size to request

/**
 * Get the highest resolution icon URL from an artwork URL
 * iTunes API provides URLs like: https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/.../AppIcon.png/512x512bb.jpg
 * We can modify the size parameter to get higher resolution (up to 1024x1024)
 * @param artworkUrl The artwork URL from iTunes API
 * @param size Desired icon size (default: 1024)
 * @returns Modified URL for highest resolution
 */
export function getHighResolutionIconUrl(artworkUrl: string, size: number = MAX_ICON_SIZE): string {
  if (!artworkUrl) {
    return "";
  }

  // The iTunes artwork URL pattern typically ends with something like /512x512bb.jpg or /100x100bb.jpg
  // We can replace this with a larger size
  const sizePattern = /\/\d+x\d+bb\.(jpg|png|jpeg)$/i;

  if (sizePattern.test(artworkUrl)) {
    // Replace the size with our desired size and use PNG for best quality
    return artworkUrl.replace(sizePattern, `/${size}x${size}bb.png`);
  }

  // If the URL doesn't match the expected pattern, try to append the size
  // This handles URLs that might not have a size suffix
  if (artworkUrl.includes("mzstatic.com")) {
    // Remove any existing extension and add our size
    const baseUrl = artworkUrl.replace(/\.(jpg|png|jpeg)$/i, "");
    return `${baseUrl}/${size}x${size}bb.png`;
  }

  // Return original URL if we can't modify it
  return artworkUrl;
}

/**
 * Validate URL for icon download
 * @param url URL to validate
 * @returns boolean indicating if URL is safe
 */
function validateIconUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);

    // Only allow HTTPS for security
    if (parsedUrl.protocol !== "https:") {
      logger.warn(`[Icon Downloader] Non-HTTPS URL rejected: ${url}`);
      return false;
    }

    // Check for allowed domains (Apple's CDN domains)
    const allowedDomains = getConfigValue("allowedScreenshotDomains");
    const hostname = parsedUrl.hostname.toLowerCase();

    if (!allowedDomains.includes(hostname)) {
      logger.warn(`[Icon Downloader] URL from non-Apple domain rejected: ${hostname}`);
      return false;
    }

    logger.log(`[Icon Downloader] URL validated: ${url}`);
    return true;
  } catch (error) {
    logger.error(`[Icon Downloader] URL validation failed: ${url}`, error);
    return false;
  }
}

/**
 * Get download timeout in milliseconds
 */
function getDownloadTimeoutMs(): number {
  try {
    return getConfigValue("maxDownloadTimeout");
  } catch (error) {
    logger.error(`[Icon Downloader] Error reading download timeout from config:`, error);
    return DEFAULT_DOWNLOAD_TIMEOUT_SECONDS * 1000;
  }
}

/**
 * Download the app icon to a file
 * @param url URL to download from
 * @param filePath Path to save the file to
 */
async function downloadIconFile(url: string, filePath: string): Promise<void> {
  // Validate URL first
  if (!validateIconUrl(url)) {
    throw new Error(`Invalid or unsafe URL: ${url}`);
  }

  // Validate the file path
  try {
    validateSafePath(filePath);
  } catch (pathError) {
    throw new Error(
      `Invalid file path: ${filePath} - ${pathError instanceof Error ? pathError.message : String(pathError)}`,
    );
  }

  // Ensure the directory exists
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  }

  const timeoutMs = getDownloadTimeoutMs();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    logger.log(`[Icon Downloader] Starting download: ${url}`);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Icon not found (404): ${url}`);
      } else if (response.status === 403) {
        throw new Error(`Access denied (403): ${url}`);
      } else {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${url}`);
      }
    }

    // Validate content type
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.startsWith("image/")) {
      logger.warn(`[Icon Downloader] Unexpected content type: ${contentType} for ${url}`);
    }

    // Download the image
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate downloaded content
    if (buffer.length < 100) {
      throw new Error(`Downloaded file too small: ${buffer.length} bytes`);
    }

    // Basic image format validation (check for PNG/JPEG magic bytes)
    if (buffer.length >= 8) {
      const isPNG = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
      const isJPEG = buffer[0] === 0xff && buffer[1] === 0xd8;

      if (!isPNG && !isJPEG) {
        logger.warn(`[Icon Downloader] Downloaded file doesn't appear to be a valid image: ${url}`);
      }
    }

    // Write file
    await writeFileAsync(filePath, buffer, { mode: 0o644 });

    // Verify file was written
    if (!fs.existsSync(filePath)) {
      throw new Error(`File was not written successfully: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    logger.log(`[Icon Downloader] Successfully downloaded: ${filePath} (${stats.size} bytes)`);
  } catch (error) {
    // Cleanup partial download
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupError) {
        logger.error(`[Icon Downloader] Failed to cleanup partial download: ${filePath}`, cleanupError);
      }
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Download timeout after ${timeoutMs / 1000}s: ${url}`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Download the app icon at the highest resolution
 * @param bundleId App bundle ID
 * @param appName App name
 * @param iconUrl Icon URL from app details (artworkUrl512 or similar)
 * @returns Path to the downloaded icon file, or null on failure
 */
export async function downloadAppIcon(bundleId: string, appName: string, iconUrl?: string): Promise<string | null> {
  try {
    logger.log(`[Icon Downloader] Starting icon download for ${appName} (${bundleId})`);

    // Get the downloads directory
    const downloadsDir = await getDownloadsDirectory();
    if (!downloadsDir) {
      showFailureToast("Could not determine downloads directory");
      return null;
    }

    // If no icon URL provided, try to fetch from iTunes API
    let finalIconUrl = iconUrl;
    if (!finalIconUrl) {
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Fetching app icon",
        message: `Looking up ${bundleId}...`,
      });

      try {
        const { fetchITunesAppDetails } = await import("./itunes-api");
        const itunesData = await fetchITunesAppDetails(bundleId);

        if (itunesData) {
          // Use the highest resolution artwork URL available
          finalIconUrl = itunesData.artworkUrl512 || itunesData.artworkUrl100 || itunesData.artworkUrl60;
          logger.log(`[Icon Downloader] Found icon URL from iTunes API: ${finalIconUrl}`);
        }

        toast.hide();
      } catch (error) {
        logger.error(`[Icon Downloader] Error fetching iTunes data:`, error);
        toast.hide();
      }
    }

    if (!finalIconUrl) {
      await showFailureToast({ title: "No icon URL available", message: "Could not find app icon" });
      return null;
    }

    // Get the highest resolution version of the icon
    const highResUrl = getHighResolutionIconUrl(finalIconUrl, MAX_ICON_SIZE);
    logger.log(`[Icon Downloader] High-res icon URL: ${highResUrl}`);

    // Create the filename: "[App Name] Icon.png"
    const sanitizedAppName = sanitizeFilename(appName.split(":")[0].trim() || "Unknown App");
    const filename = `${sanitizedAppName} Icon.png`;
    const filePath = path.join(downloadsDir, filename);

    // Show progress toast
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Downloading app icon",
      message: `Downloading ${sanitizedAppName} icon...`,
    });

    await showHUD(`Downloading ${sanitizedAppName} icon...`);

    // Download the icon
    await downloadIconFile(highResUrl, filePath);

    // Success!
    toast.style = Toast.Style.Success;
    toast.title = "Icon downloaded";
    toast.message = filename;
    toast.primaryAction = {
      title: "Show in Finder",
      shortcut: { modifiers: ["cmd"], key: "o" },
      onAction: async () => {
        await showInFinder(filePath);
      },
    };
    toast.secondaryAction = {
      title: "Copy Path",
      shortcut: { modifiers: ["cmd"], key: "c" },
      onAction: async (toast) => {
        await Clipboard.copy(filePath);
        toast.message = "Path copied to clipboard";
      },
    };

    await showHUD(`✓ Downloaded ${filename}`);

    return filePath;
  } catch (error) {
    logger.error("[Icon Downloader] Error downloading icon:", error);
    await showFailureToast({
      title: "Failed to download icon",
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
