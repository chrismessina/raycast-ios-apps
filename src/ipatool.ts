import { ChildProcess, execFile, spawn } from "child_process";
import fs from "fs";
import https from "https";
import path from "path";
import { promisify } from "util";
import { logger } from "@chrismessina/raycast-logger";
import { Alert, confirmAlert, showHUD, showToast, Toast } from "@raycast/api";
import { getConfig } from "./config";
import { IpaToolPurchasesResponse, IpaToolSearchApp, IpaToolSearchResponse } from "./types";
import {
  AppleAuthGateError,
  AppleEmptyResponseError,
  BuiltInAppError,
  ensureAuthenticated,
  Needs2FAError,
  NeedsLoginError,
  NotYetReleasedError,
} from "./utils/auth";
import { extractFilePath, safeJsonParse } from "./utils/common";
import { DownloadLayout, DownloadPlatform, layoutForFile, layoutForPlatform } from "./utils/download-layout";
import {
  acquireDownloadLock,
  createOperationDirectory,
  DownloadInProgressError,
  isLockFile,
  removeOperationDirectory,
  type DownloadLock,
} from "./utils/download-lock";
import { handleAppSearchError, handleAuthError, handleDownloadError, sanitizeQuery } from "./utils/error-handler";
import { TWO_FACTOR_PROMPT_MESSAGE } from "./utils/errors";
import { cleanAppNameForFilename } from "./utils/formatting";
import {
  analyzeIpatoolError,
  builtInAppMessage,
  isAppleBuiltInApp,
  type IpatoolErrorInfo,
} from "./utils/ipatool-error-patterns";
import { createSecureIpatoolProcess, IpatoolSetupError } from "./utils/ipatool-validator";
import {
  convertIpaToolSearchAppToAppDetails,
  convertITunesResultToAppDetails,
  fetchITunesAppDetails,
} from "./utils/itunes-api";
import { getDownloadsDirectory, IPATOOL_PATH } from "./utils/paths";
import { registerTempFile, unregisterTempFile } from "./utils/temp-file-manager";

// Retry configuration for handling transient network errors
const MAX_RETRIES = 3; // Maximum number of retry attempts
const INITIAL_RETRY_DELAY = 2000; // Initial delay between retries (2 seconds)
const MAX_RETRY_DELAY = 10000; // Maximum delay between retries (10 seconds)

const execFileAsync = promisify(execFile);

// Constants for prerequisite validation
const MIN_DISK_SPACE_MB = 300; // 300 MB fallback if expected size is not available
// ipatool holds an intermediate and the artifact it becomes on disk at the same
// time, on both platforms, so free space must cover roughly twice the final
// size. Measured on macOS: a 192 MB app peaked at 363 MB.
const DOWNLOAD_PEAK_SIZE_MULTIPLIER = 2;
const BYTES_PER_MB = 1024 * 1024;

// Constants for file integrity verification
const MIN_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB minimum file size

/**
 * Interface for prerequisite validation results
 */
interface ValidationResult {
  isValid: boolean;
  errorMessage?: string;
  cancelled?: boolean;
}

/**
 * Result of the existing-download lookup.
 *
 *   none      — no matching file in the downloads directory
 *   overwrite — a matching file exists and the user confirmed overwrite
 *   skipped   — a matching file exists and the user cancelled
 */
export type ExistingDownloadCheck = { kind: "none" } | { kind: "overwrite" } | { kind: "skipped" };

/**
 * Look for an existing IPA in the downloads directory that matches this app and,
 * if found, prompt the user to overwrite. Runs before any progress UI so the
 * caller can decide whether to start the download flow at all.
 *
 * Match strategy mirrors the rename logic at the end of a successful download:
 * exact filenames first ({bundleId}.ipa, {AppName} {Version}.ipa, {AppName}.ipa),
 * then a fuzzy fallback on bundleId substring only. The match is version-specific:
 * a different version of the same app ({AppName} {OtherVersion}.ipa) is NOT a
 * collision and downloads alongside the existing file without a prompt.
 */
/**
 * Finds an existing download for this app WITHOUT prompting.
 *
 * Split out of `checkForExistingDownload` so a non-interactive caller — the AI
 * tool, which cannot push a view — can detect a collision too. That path used
 * to skip detection entirely and walk into `downloadApp`, whose completion
 * handler unlinks whatever sits at the destination, so it replaced files
 * silently.
 */
export async function findExistingDownload(
  bundleId: string,
  appName?: string,
  appVersion?: string,
  platform: DownloadPlatform = "iphone",
): Promise<{ filePath: string; sizeBytes: number } | null> {
  const downloadsDir = getDownloadsDirectory();
  // A Mac download lands as `.pkg`, so looking only for `.ipa` would miss an
  // existing Mac file and silently re-download it.
  const { final: ext } = layoutForPlatform(platform);

  // Must match the completion rename exactly, which cleans marketing suffixes
  // BEFORE sanitizing (see the `close` handler). Skipping the clean step made
  // the two construct different names, so an existing file was never found and
  // the overwrite prompt never appeared — invisible for terse iOS names, but
  // Mac App Store titles are full of " - " taglines ("Vista - Just open the
  // image." renames to `Vista 3.6.pkg` while this looked for the whole tagline).
  const sanitizedName = appName ? cleanAppNameForFilename(appName).replace(/[/\\?%*:|"<>]/g, "-") : undefined;
  const possibleFilenames = [
    `${bundleId}${ext}`,
    sanitizedName && appVersion ? `${sanitizedName} ${appVersion}${ext}` : undefined,
    sanitizedName ? `${sanitizedName}${ext}` : undefined,
  ].filter(Boolean) as string[];

  for (const filename of possibleFilenames) {
    const filePath = path.join(downloadsDir, filename);
    try {
      const stats = await fs.promises.stat(filePath);
      logger.log(`[validation] Found existing file: ${filePath} (${Math.ceil(stats.size / BYTES_PER_MB)} MB)`);
      return { filePath, sizeBytes: stats.size };
    } catch {
      // File doesn't exist, continue checking
    }
  }

  try {
    const files = await fs.promises.readdir(downloadsDir);
    // Matches ipatool's raw intermediate name, `{bundleId}_{adamId}_{version}{ext}`.
    //
    // This was `file.includes(bundleId)`, which was wrong on BOTH axes: no
    // bundle boundary, so `com.example.app` matched `com.example.app2`'s file —
    // a different app entirely; and no version, so an older raw file matched
    // despite the version-specific contract this function documents. We still
    // deliberately do NOT match on the app-name prefix: every prior version
    // shares the "{Name} " prefix and differs only by version.
    const similarFiles = files.filter((file) => {
      if (isLockFile(file)) return false;
      if (!file.endsWith(ext)) return false;
      if (!file.startsWith(`${bundleId}_`)) return false;
      return appVersion ? file.endsWith(`_${appVersion}${ext}`) : true;
    });

    if (similarFiles.length > 0) {
      const filePath = path.join(downloadsDir, similarFiles[0]);
      try {
        const stats = await fs.promises.stat(filePath);
        logger.log(
          `[validation] Found similar existing file: ${filePath} (${Math.ceil(stats.size / BYTES_PER_MB)} MB)`,
        );
        return { filePath, sizeBytes: stats.size };
      } catch (error) {
        logger.warn(`[validation] Could not stat similar file:`, error);
      }
    }
  } catch (error) {
    logger.warn(`[validation] Could not read downloads directory:`, error);
  }

  return null;
}

export async function checkForExistingDownload(
  bundleId: string,
  appName?: string,
  appVersion?: string,
  platform: DownloadPlatform = "iphone",
): Promise<ExistingDownloadCheck> {
  const displayName = appName || bundleId;
  const existing = await findExistingDownload(bundleId, appName, appVersion, platform);

  if (!existing) {
    return { kind: "none" };
  }

  const existingFileMB = Math.ceil(existing.sizeBytes / BYTES_PER_MB);
  const confirmed = await confirmAlert({
    title: "File Already Exists",
    message: `A file for "${displayName}" already exists (${existingFileMB} MB).\n\nDo you want to overwrite it?`,
    primaryAction: {
      title: "Overwrite",
      style: Alert.ActionStyle.Destructive,
    },
  });

  if (!confirmed) {
    logger.log(`[validation] Skipped download: file already exists (${path.basename(existing.filePath)})`);
    return { kind: "skipped" };
  }

  logger.log(`[validation] ✓ User confirmed overwrite of existing file`);
  return { kind: "overwrite" };
}

/**
 * Interface for file integrity verification results
 */
interface IntegrityResult {
  isValid: boolean;
  errorMessage?: string;
  shouldRetry?: boolean;
}

/**
 * Validates download prerequisites before starting app download
 * @param bundleId Bundle identifier of the app
 * @param appName Optional app name for better error messages
 * @param expectedSizeBytes Optional expected app size in bytes
 * @returns Promise<ValidationResult> - validation result
 */
export async function validateDownloadPrereqs(
  bundleId: string,
  appName?: string,
  expectedSizeBytes?: number,
): Promise<ValidationResult> {
  const displayName = appName || bundleId;
  logger.log(`[validation] Starting prerequisite validation for ${displayName}`);

  try {
    // Get the downloads directory
    const downloadsDir = getDownloadsDirectory();
    logger.log(`[validation] Downloads directory: ${downloadsDir}`);

    // 1. Check write permission to downloads directory
    try {
      await fs.promises.access(downloadsDir, fs.constants.W_OK);
      logger.log(`[validation] ✓ Write permission verified for downloads directory`);
    } catch (error) {
      const errorMsg = `Cannot write to downloads directory: ${downloadsDir}. Please check permissions or change the download path in preferences.`;
      logger.error(`[validation] Write permission check failed:`, error);

      await showToast({
        style: Toast.Style.Failure,
        title: "Permission Error",
        message: "Cannot write to downloads directory",
      });

      return { isValid: false, errorMessage: errorMsg };
    }

    // 2. Check available disk space
    //
    // Budget the PEAK, not the final artifact. ipatool never writes straight
    // through: macOS holds `.pkg.ipatool-encrypted` and `.pkg.ipatool-decrypted`
    // at once before they collapse (measured: 363 MB peak for a 192 MB app),
    // and the iOS repack holds `.ipa.tmp` alongside the `.ipa` it assembles.
    // Budgeting 1x passed validation and then ran out of space mid-decrypt.
    const peakMultiplier = DOWNLOAD_PEAK_SIZE_MULTIPLIER;
    const requiredSpaceBytes = expectedSizeBytes
      ? expectedSizeBytes * peakMultiplier
      : MIN_DISK_SPACE_MB * BYTES_PER_MB;
    const requiredSpaceMB = Math.ceil(requiredSpaceBytes / BYTES_PER_MB);

    try {
      const stats = await fs.promises.statfs(downloadsDir);
      const availableBytes = stats.bavail * stats.bsize;
      const availableMB = Math.floor(availableBytes / BYTES_PER_MB);

      logger.log(`[validation] Available disk space: ${availableMB} MB, Required: ${requiredSpaceMB} MB`);

      if (availableBytes < requiredSpaceBytes) {
        const errorMsg = `Insufficient disk space. Available: ${availableMB} MB, Required: ${requiredSpaceMB} MB. Please free up space or change download location.`;
        logger.error(`[validation] Insufficient disk space`);

        await showToast({
          style: Toast.Style.Failure,
          title: "Insufficient Disk Space",
          message: `Need ${requiredSpaceMB} MB, have ${availableMB} MB`,
        });

        return { isValid: false, errorMessage: errorMsg };
      }

      logger.log(`[validation] ✓ Sufficient disk space available`);
    } catch (error) {
      logger.warn(`[validation] Could not check disk space, continuing:`, error);
      // Don't fail validation if we can't check disk space, just warn
    }

    // 3. Existing-file detection has moved upstream into checkForExistingDownload()
    //    so the user is prompted before any progress UI is shown. By the time we
    //    reach this validator, the caller has already decided to overwrite.

    // 4. Check network connectivity (try multiple methods with graceful fallbacks)
    try {
      // First try ping if available
      let networkCheckPassed = false;
      let networkError: Error | null = null;

      try {
        const { stdout } = await execFileAsync("ping", ["-c", "1", "-W", "5000", "apple.com"], {
          timeout: 10000,
        });

        if (
          stdout.includes("1 packets transmitted, 1 received") ||
          stdout.includes("1 packets transmitted, 1 packets received")
        ) {
          networkCheckPassed = true;
          logger.log(`[validation] ✓ Network connectivity verified via ping`);
        }
      } catch (pingError) {
        networkError = pingError instanceof Error ? pingError : new Error(String(pingError));
        logger.warn(
          `[validation] Ping command failed (may not be available in this environment): ${networkError.message}`,
        );

        // If ping fails due to command not found, try alternative network check
        if (networkError.message.includes("ENOENT") || networkError.message.includes("spawn ping")) {
          logger.log(`[validation] Ping command not available, trying alternative network check...`);

          try {
            // Try a simple HTTP request to Apple as an alternative
            await new Promise<void>((resolve, reject) => {
              const req = https.request(
                "https://www.apple.com/",
                {
                  method: "HEAD",
                  timeout: 10000,
                },
                (res) => {
                  if (res.statusCode && res.statusCode < 400) {
                    networkCheckPassed = true;
                    logger.log(`[validation] ✓ Network connectivity verified via HTTPS request to apple.com`);
                    resolve();
                  } else {
                    reject(new Error(`HTTP request failed with status ${res.statusCode}`));
                  }
                },
              );

              req.on("error", reject);
              req.on("timeout", () => {
                req.destroy();
                reject(new Error("Request timeout"));
              });

              req.end();
            });
          } catch (httpError) {
            logger.warn(`[validation] Alternative HTTP connectivity check also failed:`, httpError);
            // We'll handle this below
          }
        }
      }

      if (!networkCheckPassed) {
        // Only fail validation if we're confident there's actually no network
        // Give the benefit of the doubt in sandboxed environments
        if (networkError && !networkError.message.includes("ENOENT") && !networkError.message.includes("spawn ping")) {
          const errorMsg = `Network connectivity check failed. Please check your internet connection and try again.`;
          logger.error(`[validation] Network connectivity validation failed`);

          await showToast({
            style: Toast.Style.Failure,
            title: "Network Error",
            message: "Cannot reach apple.com",
          });

          return { isValid: false, errorMessage: errorMsg };
        } else {
          // In sandboxed environments where ping isn't available, just log a warning and continue
          logger.warn(
            `[validation] Network connectivity check inconclusive (ping not available), proceeding with download`,
          );
        }
      }
    } catch (error) {
      // Unexpected error in network check logic
      logger.warn(`[validation] Unexpected error in network connectivity check, proceeding:`, error);
      // Don't fail validation for unexpected network check errors
    }

    logger.log(`[validation] ✓ All prerequisites validated successfully for ${displayName}`);
    return { isValid: true };
  } catch (error) {
    const errorMsg = `Prerequisite validation failed: ${error instanceof Error ? error.message : String(error)}`;
    logger.error(`[validation] Validation error:`, error);

    await showToast({
      style: Toast.Style.Failure,
      title: "Validation Error",
      message: "Could not validate download requirements",
    });

    return { isValid: false, errorMessage: errorMsg };
  }
}

/**
 * Checks if an app is free (price is $0) and eligible for automatic purchase
 * @param price The price string from app details
 * @returns boolean - true if app is free and eligible for purchase
 */
export function isFreeApp(price?: string): boolean {
  if (!price) {
    return false;
  }

  // Check if price is exactly "0" or "0.00" or similar free indicators
  const numericPrice = parseFloat(price);
  const isFree = numericPrice === 0;

  logger.log(`[ipatool] App price eligibility check: price="${price}", numeric=${numericPrice}, isFree=${isFree}`);

  return isFree;
}

/**
 * Result of an app license purchase attempt.
 *
 * On failure, `errorType` carries the analyzed ipatool error category so the
 * caller can produce an accurate message (e.g. rate-limited vs. a real
 * restriction) instead of guessing. Auth failures are not represented here —
 * those throw NeedsLoginError instead.
 */
export interface PurchaseResult {
  success: boolean;
  errorType?: IpatoolErrorInfo["errorType"];
  userMessage?: string;
}

/**
 * Attempts to purchase an app using ipatool
 * @param bundleId The bundle identifier of the app
 * @param appName Optional app name for logging
 * @returns Promise<PurchaseResult> - success flag plus error classification on failure
 */
const PURCHASE_TIMEOUT_MS = 60_000;

export async function purchaseApp(
  bundleId: string,
  appName?: string,
  options?: { suppressHUD?: boolean; platform?: DownloadPlatform },
): Promise<PurchaseResult> {
  const displayName = appName || bundleId;
  const done = logger.time(`purchaseApp:${displayName}`);
  logger.log(`[ipatool] Attempting to purchase app: ${displayName} (${bundleId})`);

  const suppressHUD = options?.suppressHUD ?? false;
  // A HUD that fails to show must not turn a granted license into a failure.
  const hud = hudFor(suppressHUD);
  await hud(`Attempting to purchase ${displayName}...`);

  // Use a promise-based spawn that captures stdout even on non-zero exit
  const stdout = await new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    // A license is acquired PER PLATFORM. The recovery purchase inside a Mac
    // download was previously handed `options` (which carries `platform`) by a
    // signature that only read `suppressHUD`, so it silently fell back to
    // ipatool's default and could license the wrong binary. Omitted for iPhone
    // on purpose, matching `downloadApp`: no flag preserves ipatool's own
    // resolution for universal and iPad-only titles.
    const purchasePlatform = options?.platform ?? "iphone";
    const child = spawn(IPATOOL_PATH, [
      "purchase",
      "--bundle-identifier",
      bundleId,
      ...(purchasePlatform !== "iphone" ? ["--platform", purchasePlatform] : []),
      "--format",
      "json",
      "--non-interactive",
      "--verbose",
    ]);

    child.stdout?.on("data", (data: Buffer) => {
      out += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      err += data.toString();
    });
    // Apple can leave this request hanging, and the download lock's heartbeat
    // keeps refreshing while it waits, so without a deadline every other
    // command stays locked out of this app.
    let killTimer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      logger.warn(`[ipatool] Purchase for ${displayName} timed out after ${PURCHASE_TIMEOUT_MS / 1000}s`);
      // Matches the timeout pattern in ipatool-error-patterns.ts.
      err += `\npurchase timed out after ${PURCHASE_TIMEOUT_MS / 1000}s`;
      // Armed before signaling: kill() can emit `error` synchronously, and
      // that handler must find this timer to clear it.
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.kill("SIGTERM");
    }, PURCHASE_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      // Always resolve with stdout so we can parse errors from ipatool's JSON output
      // (ipatool writes structured error info to stdout, not stderr)
      resolve(out + "\n" + err);
    });
  });

  logger.log(`[ipatool] Purchase output for ${displayName}: ${stdout}`);

  // Parse all JSON lines from ipatool output
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"));

  let lastError = "";
  let succeeded = false;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj["success"] === true || obj["message"] === "license obtained") {
        succeeded = true;
        break;
      }
      if (typeof obj["error"] === "string") {
        const errStr = String(obj["error"]).toLowerCase();
        if (
          errStr.includes("already purchased") ||
          errStr.includes("already owned") ||
          errStr.includes("license already exists")
        ) {
          succeeded = true;
          break;
        }
        lastError = String(obj["error"]);
      }
    } catch {
      // skip non-JSON lines
    }
  }

  // Also check raw output for success indicators
  const outputLower = stdout.toLowerCase();
  if (!succeeded && (outputLower.includes('"success":true') || outputLower.includes("license already exists"))) {
    succeeded = true;
  }

  if (succeeded) {
    done({ result: "success" });
    logger.info(`[ipatool] Purchase successful or already owned for ${displayName}`);
    await hud(`Successfully purchased ${displayName}`);
    return { success: true };
  }

  // Purchase failed — analyze the error from stdout JSON
  const errorToAnalyze = lastError || stdout;
  logger.error(`[ipatool] Purchase failed for ${displayName}: ${lastError || "(no parsed error)"}`);
  const errorAnalysis = analyzeIpatoolError(errorToAnalyze, "", "download");

  // `ipatool purchase` takes the same silent re-login as download when the
  // session token has expired, so Apple can answer it with a 2FA prompt too.
  if (errorAnalysis.is2FARequired) {
    logger.error(`[ipatool] Apple asked for a 2FA code during purchase of ${displayName}`);
    done({ result: "needs_2fa" });
    throw new Needs2FAError(TWO_FACTOR_PROMPT_MESSAGE);
  }

  if (errorAnalysis.isAuthError) {
    logger.error(`[ipatool] Auth error during purchase: ${errorAnalysis.userMessage}`);
    done({ result: "auth_error" });
    // Throw so the download flow can catch this and redirect to sign-in
    throw new NeedsLoginError(errorAnalysis.userMessage);
  }

  // Pre-release / Coming Soon apps: throw a typed error so the hook can show
  // the specific "Not Released Yet" toast without re-parsing a wrapped string.
  // The downstream re-analysis loses the source signature once it's wrapped
  // into "Could not get a license for X: ...", so a typed error is the only
  // reliable way to carry the classification across the boundary.
  if (errorAnalysis.errorType === "not_yet_released") {
    logger.error(`[ipatool] Pre-release / Coming Soon detected during purchase: ${errorAnalysis.userMessage}`);
    done({ result: "not_yet_released" });
    throw new NotYetReleasedError(errorAnalysis.userMessage);
  }

  // Same reasoning as above: a free app hits "license is required" first, so
  // Apple's gate surfaces HERE rather than on the download call. Returning it
  // as a plain PurchaseResult let the caller wrap it into "Could not get a
  // license for X: ...", which erased the signature and produced a generic
  // toast well over the length limit.
  // Same reasoning as the auth gate below: a free app fails download with
  // "license is required" first, so this can surface from the PURCHASE call
  // rather than the download one. Returning it as a plain PurchaseResult let
  // the caller wrap it into "Could not get a license for X: ...", which erased
  // the classification and produced a generic toast.
  if (errorAnalysis.errorType === "apple_empty_response") {
    logger.error(`[ipatool] Apple returned an empty payload during purchase for ${displayName}`);
    done({ result: "failed", errorType: errorAnalysis.errorType });
    throw new AppleEmptyResponseError(errorAnalysis.userMessage);
  }

  if (errorAnalysis.errorType === "apple_auth_gate") {
    logger.error(`[ipatool] Apple auth gate during purchase for ${displayName}: ${errorAnalysis.userMessage}`);
    done({ result: "failed", errorType: errorAnalysis.errorType });
    throw new AppleAuthGateError(errorAnalysis.userMessage);
  }

  done({ result: "failed", errorType: errorAnalysis.errorType });
  return { success: false, errorType: errorAnalysis.errorType, userMessage: errorAnalysis.userMessage };
}

/**
 * Compares the downloaded file's size against the size ipatool reported.
 *
 * Container-independent: it reads metadata, not archive structure, so it is
 * valid for a xar `.pkg` as much as a ZIP `.ipa`. Returns a failure result, or
 * null when there is nothing to check or the size is within tolerance.
 */
function checkReportedSize(
  actualSize: number,
  ipatoolJson: Record<string, string | number> | null | undefined,
  displayName: string,
): IntegrityResult | null {
  const expectedSize = ipatoolJson?.fileSize;
  if (typeof expectedSize !== "number" || !expectedSize) return null;

  const sizeTolerancePercent = 0.05; // 5% tolerance for size differences
  if (Math.abs(actualSize - expectedSize) > expectedSize * sizeTolerancePercent) {
    const errorMsg = `File size mismatch: expected ${Math.round(expectedSize / BYTES_PER_MB)} MB, got ${Math.round(actualSize / BYTES_PER_MB)} MB`;
    logger.error(`[integrity] File size mismatch for ${displayName}: expected ${expectedSize}, got ${actualSize}`);
    return { isValid: false, errorMessage: errorMsg, shouldRetry: true };
  }

  logger.log(`[integrity] ✓ File size matches expected: ${Math.round(actualSize / BYTES_PER_MB)} MB`);
  return null;
}

/**
 * Verifies the integrity of a downloaded iOS app file
 * @param filePath Path to the downloaded .ipa file
 * @param appName Optional app name for better error messages
 * @param ipatoolJson Optional ipatool JSON response containing metadata
 * @returns Promise<IntegrityResult> - integrity verification result
 */
export async function verifyFileIntegrity(
  filePath: string,
  appName?: string,
  ipatoolJson?: Record<string, string | number> | null,
): Promise<IntegrityResult> {
  const displayName = appName || path.basename(filePath);
  // Derived from the artifact rather than passed in: the caller sees a path, and
  // deriving means a future platform cannot get the wrong container check.
  const layout = layoutForFile(filePath);
  logger.log(`[integrity] Starting file integrity verification for ${displayName} (${layout.containerName})`);

  try {
    // Basic: ensure file exists and size > 1 MB
    if (!fs.existsSync(filePath)) {
      const errorMsg = `Downloaded file not found: ${filePath}`;
      logger.error(`[integrity] File not found: ${filePath}`);
      return { isValid: false, errorMessage: errorMsg, shouldRetry: true };
    }

    const stats = fs.statSync(filePath);
    if (stats.size < MIN_FILE_SIZE_BYTES) {
      const errorMsg = `Downloaded file too small: ${Math.round(stats.size / 1024)} KB (minimum: 1 MB)`;
      logger.error(`[integrity] File too small: ${filePath} (${stats.size} bytes)`);
      return { isValid: false, errorMessage: errorMsg, shouldRetry: true };
    }

    logger.log(`[integrity] ✓ File exists and has valid size: ${Math.round(stats.size / BYTES_PER_MB)} MB`);

    // Structural: verify ZIP magic bytes and scan central directory for Payload/*.app and Info.plist
    // Uses streaming reads instead of adm-zip to avoid loading entire file into memory
    // (large IPAs like 872 MB would crash the Raycast worker with OOM)
    const fd = fs.openSync(filePath, "r");
    try {
      // Container magic, which differs per platform: `PK\x03\x04` for an iOS
      // `.ipa`, `xar!` for a macOS `.pkg`.
      const expectedMagic = layout.magic;
      const magic = Buffer.alloc(4);
      fs.readSync(fd, magic, 0, 4, 0);
      if (expectedMagic.some((byte, index) => magic[index] !== byte)) {
        const errorMsg = `Downloaded file is not a valid ${layout.containerName} archive (bad magic bytes)`;
        logger.error(`[integrity] Invalid ${layout.containerName} magic bytes: ${filePath}`);
        return { isValid: false, errorMessage: errorMsg, shouldRetry: true };
      }

      // A `.pkg` is a xar archive, and the structural walk below is ZIP-specific
      // — central directory, `Payload/*.app`, `Info.plist`. Stopping at magic +
      // size for xar is a deliberate ceiling: proving a xar payload really
      // contains an app bundle means parsing its TOC, which buys nothing until a
      // corrupt `.pkg` is actually observed. Upgrade then, not before.
      if (!layout.isZip) {
        logger.log(`[integrity] ✓ ${layout.containerName} magic verified for ${displayName} (no structural walk)`);
        // Skipping the ZIP walk must NOT skip the container-INDEPENDENT checks.
        // The metadata size comparison below describes the final artifact
        // whatever its container, so a `.pkg` that is merely `xar!` + plausible
        // length would otherwise pass while being far smaller than ipatool said.
        const sizeResult = checkReportedSize(stats.size, ipatoolJson, displayName);
        return sizeResult ?? { isValid: true };
      }

      // Read the end of the file to find the End of Central Directory record (EOCD)
      // EOCD is at most 65557 bytes from the end (22 byte fixed + up to 65535 comment)
      const tailSize = Math.min(stats.size, 65557);
      const tail = Buffer.alloc(tailSize);
      fs.readSync(fd, tail, 0, tailSize, stats.size - tailSize);

      // Search backwards for EOCD signature (PK\x05\x06)
      let eocdOffset = -1;
      for (let i = tailSize - 22; i >= 0; i--) {
        if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
          eocdOffset = i;
          break;
        }
      }

      if (eocdOffset === -1) {
        const errorMsg = `Downloaded IPA file is corrupted (no central directory found)`;
        logger.error(`[integrity] No EOCD record found: ${filePath}`);
        return { isValid: false, errorMessage: errorMsg, shouldRetry: true };
      }

      // Parse EOCD to find central directory offset and size
      const cdSize = tail.readUInt32LE(eocdOffset + 12);
      const cdOffset = tail.readUInt32LE(eocdOffset + 16);

      if (cdOffset + cdSize > stats.size || cdSize === 0) {
        const errorMsg = `Downloaded IPA file is empty or corrupted`;
        logger.error(`[integrity] Invalid central directory: offset=${cdOffset}, size=${cdSize}`);
        return { isValid: false, errorMessage: errorMsg, shouldRetry: true };
      }

      // Read central directory entries to check for Payload/*.app and Info.plist
      // Only read the central directory portion, not the entire file
      const cd = Buffer.alloc(cdSize);
      fs.readSync(fd, cd, 0, cdSize, cdOffset);

      let foundPayloadApp = false;
      let foundInfoPlist = false;
      let pos = 0;

      while (pos + 46 <= cdSize) {
        // Check for central directory file header signature (PK\x01\x02)
        if (cd[pos] !== 0x50 || cd[pos + 1] !== 0x4b || cd[pos + 2] !== 0x01 || cd[pos + 3] !== 0x02) {
          break;
        }

        const nameLen = cd.readUInt16LE(pos + 28);
        const extraLen = cd.readUInt16LE(pos + 30);
        const commentLen = cd.readUInt16LE(pos + 32);

        if (pos + 46 + nameLen > cdSize) break;

        const entryName = cd.toString("utf8", pos + 46, pos + 46 + nameLen);

        if (!foundPayloadApp && entryName.startsWith("Payload/") && entryName.includes(".app/")) {
          foundPayloadApp = true;
          logger.log(`[integrity] ✓ Found Payload app structure: ${entryName}`);
        }

        if (!foundInfoPlist && entryName.includes("Info.plist")) {
          foundInfoPlist = true;
          logger.log(`[integrity] ✓ Found Info.plist: ${entryName}`);
        }

        if (foundPayloadApp && foundInfoPlist) break;

        pos += 46 + nameLen + extraLen + commentLen;
      }

      if (!foundPayloadApp) {
        const errorMsg = `Downloaded IPA file missing required Payload/*.app structure`;
        logger.error(`[integrity] Missing Payload/*.app structure in: ${filePath}`);
        return { isValid: false, errorMessage: errorMsg, shouldRetry: true };
      }

      if (!foundInfoPlist) {
        const errorMsg = `Downloaded IPA file missing required Info.plist`;
        logger.error(`[integrity] Missing Info.plist in: ${filePath}`);
        return { isValid: false, errorMessage: errorMsg, shouldRetry: true };
      }

      logger.log(`[integrity] ✓ IPA file has valid structure with Payload/*.app and Info.plist`);
    } finally {
      fs.closeSync(fd);
    }

    // If ipatool JSON contains "fileSize" or "checksum", compare
    if (ipatoolJson) {
      const sizeResult = checkReportedSize(stats.size, ipatoolJson, displayName);
      if (sizeResult) return sizeResult;

      if (ipatoolJson.checksum && typeof ipatoolJson.checksum === "string") {
        // For checksum verification, we would need to implement the appropriate hash algorithm
        // This is a placeholder for future checksum verification implementation
        logger.log(`[integrity] Checksum verification available (${ipatoolJson.checksum}) but not implemented yet`);
      }
    }

    logger.log(`[integrity] ✓ File integrity verification completed successfully for ${displayName}`);
    return { isValid: true };
  } catch (error) {
    const errorMsg = `File integrity verification failed: ${error instanceof Error ? error.message : String(error)}`;
    logger.error(`[integrity] Verification error for ${filePath}:`, error);
    return { isValid: false, errorMessage: errorMsg, shouldRetry: false };
  }
}

/**
 * Search for iOS apps using ipatool
 * @param query Search query
 * @param limit Maximum number of results
 * @returns Array of app results
 */
export async function searchApps(query: string, limit = 20): Promise<IpaToolSearchApp[]> {
  try {
    logger.log(`[ipatool] Searching for apps with query: "${sanitizeQuery(query)}", limit: ${limit}`);

    // Ensure we're authenticated before proceeding
    const isAuthenticated = await ensureAuthenticated();
    if (!isAuthenticated) {
      // Error already handled by ensureAuthenticated via handleAuthError
      return [];
    }

    // Execute the search command with proper formatting and non-interactive mode
    // Using execFile with array arguments to prevent command injection
    logger.log(`[ipatool] Executing search for query: ${sanitizeQuery(query)} with limit: ${limit}`);
    const { stdout } = await execFileAsync(IPATOOL_PATH, [
      "search",
      query,
      "-l",
      limit.toString(),
      "--format",
      "json",
      "--non-interactive",
    ]);

    // Parse the JSON output with fallback to empty response if parsing fails
    logger.log(`[ipatool] Received search response, parsing JSON...`);
    const searchResponse = safeJsonParse<IpaToolSearchResponse>(stdout, { count: 0, apps: [] });
    logger.log(`[ipatool] Found ${searchResponse.apps?.length || 0} apps in search results`);

    return searchResponse.apps || [];
  } catch (error) {
    if (error instanceof IpatoolSetupError) {
      logger.error("ipatool setup failed during search:", error);
      return [];
    }

    logger.error("Error searching apps:", error);
    await handleAppSearchError(error instanceof Error ? error : new Error(String(error)), query, "searchApps");
    return [];
  }
}

/**
 * Largest page `ipatool list-purchases` will serve. `-l 101` is rejected
 * outright ("max results must not exceed 100"), so this is a hard ceiling,
 * not a tuning knob.
 */
export const PURCHASES_PAGE_SIZE = 100;

/**
 * One page of the signed-in Apple ID's purchase history.
 *
 * `ipatool list-purchases` pages are **1-indexed** and ordered purchase-date
 * descending; the order is stable and pages do not overlap. A `--platform`
 * filter exists (iphone/ipad/appletv/visionos/macos — notably NOT watchos,
 * which `download` and `purchase` do accept) but we never pass it. The records
 * carry no icon, rating, or genre — callers enrich via iTunes.
 *
 * Auth errors (`NeedsLoginError`, `Needs2FAError`, `AppleAuthGateError`) are
 * left to propagate so the caller can push the login flow.
 *
 * @param page 1-indexed page number
 * @param limit Records per page, capped at {@link PURCHASES_PAGE_SIZE}
 * @returns The page plus the account-wide `totalCount`
 */
export async function listPurchases(page: number, limit = PURCHASES_PAGE_SIZE): Promise<IpaToolPurchasesResponse> {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError(`listPurchases: page must be a positive integer (1-indexed), got ${page}`);
  }
  const cappedLimit = Math.min(Math.max(Math.trunc(limit), 1), PURCHASES_PAGE_SIZE);

  const isAuthenticated = await ensureAuthenticated();
  if (!isAuthenticated) {
    throw new NeedsLoginError("Sign in with your Apple ID to see your purchases");
  }

  logger.log(`[ipatool] Listing purchases: ipatool page ${page}, limit ${cappedLimit}`);
  const { stdout } = await execFileAsync(IPATOOL_PATH, [
    "list-purchases",
    "--format",
    "json",
    "--non-interactive",
    "-l",
    cappedLimit.toString(),
    "-p",
    page.toString(),
  ]);

  // ipatool reports some failures on stdout with exit code 0, so a parsed
  // payload is not by itself a success.
  const parsed = safeJsonParse<Partial<IpaToolPurchasesResponse> & { error?: string }>(stdout, {});
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  if (!Array.isArray(parsed.apps)) {
    throw new Error("ipatool returned no purchase list — try `ipatool auth info` in a terminal");
  }

  logger.log(`[ipatool] Purchases page ${page}: ${parsed.apps.length} of ${parsed.totalCount ?? 0} total`);
  return {
    apps: parsed.apps,
    count: parsed.count ?? parsed.apps.length,
    totalCount: parsed.totalCount ?? parsed.apps.length,
    page: parsed.page ?? page,
  };
}

/**
 * Download an app from the App Store using ipatool
 * @param bundleId Bundle identifier of the app to download
 * @param appName Optional app name for logging
 * @param appVersion Optional app version for logging
 * @param price Optional price for determining if app is paid
 * @param retryCount Current retry attempt (used for exponential backoff)
 * @param retryDelay Current retry delay in milliseconds
 * @returns Promise<string | null | undefined> - Path on success; null if user cancelled; undefined on failure
 */
export async function downloadApp(
  bundleId: string,
  appName = "",
  appVersion = "",
  price = "0",
  retryCount = 0,
  retryDelay = INITIAL_RETRY_DELAY,
  options?: {
    suppressHUD?: boolean;
    onProgress?: (progress: number) => void;
    expectedSizeBytes?: number;
    /** Defaults to iPhone, which is what every caller assumed before Mac support. */
    platform?: DownloadPlatform;
  },
): Promise<string | null | undefined> {
  try {
    logger.log(`[ipatool] Starting download for bundleId: ${bundleId}, app: ${appName}, version: ${appVersion}`);

    // Validate download prerequisites first (only on initial attempt, not retries)
    if (retryCount === 0) {
      logger.log(`[ipatool] Validating download prerequisites...`);

      // Use provided expectedSizeBytes or fetch from iTunes API as fallback
      let expectedSizeBytes: number | undefined = options?.expectedSizeBytes;

      if (!expectedSizeBytes) {
        try {
          const itunesDetails = await fetchITunesAppDetails(bundleId);
          if (itunesDetails?.fileSizeBytes) {
            expectedSizeBytes = itunesDetails.fileSizeBytes;
            logger.log(
              `[validation] Got expected app size from iTunes API: ${Math.ceil(expectedSizeBytes / BYTES_PER_MB)} MB`,
            );
          }
        } catch (error) {
          logger.warn(`[validation] Could not fetch app size from iTunes API, using fallback:`, error);
        }
      } else {
        logger.log(`[validation] Using provided expected app size: ${Math.ceil(expectedSizeBytes / BYTES_PER_MB)} MB`);
      }

      const validation = await validateDownloadPrereqs(bundleId, appName, expectedSizeBytes);
      if (!validation.isValid) {
        const msg = validation.errorMessage || "Prerequisite validation failed";
        if (validation.cancelled) {
          // Existing file; download skipped as a non-error outcome.
          logger.log(`[ipatool] Skipping download during validation: ${msg}`);
          return null;
        }
        logger.error(`[ipatool] Prerequisite validation failed: ${msg}`);
        throw new Error(msg);
      }
      logger.log(`[ipatool] ✓ Prerequisites validated successfully`);
    }

    // Ensure authenticated before download using centralized flow
    const isAuthenticated = await ensureAuthenticated();
    if (!isAuthenticated) {
      return null;
    }

    // Get the downloads directory from preferences
    const downloadsDir = getDownloadsDirectory();

    // Get expected file size for progress tracking
    // Use provided size or fetch from iTunes API as fallback (only on initial attempt to avoid duplicate calls)
    let expectedSizeBytes: number | undefined = options?.expectedSizeBytes;

    logger.log(
      `[ipatool] Download params - retryCount: ${retryCount}, provided expectedSizeBytes: ${expectedSizeBytes}, suppressHUD: ${options?.suppressHUD}, hasOnProgress: ${Boolean(options?.onProgress)}`,
    );

    if (!expectedSizeBytes && retryCount === 0) {
      try {
        const itunesDetails = await fetchITunesAppDetails(bundleId);
        if (itunesDetails?.fileSizeBytes) {
          expectedSizeBytes = itunesDetails.fileSizeBytes;
          logger.log(
            `[ipatool] Got expected app size from iTunes API: ${Math.ceil(expectedSizeBytes / BYTES_PER_MB)} MB`,
          );
        }
      } catch (error) {
        logger.warn(`[ipatool] Could not fetch app size from iTunes API for progress tracking:`, error);
      }
    } else if (expectedSizeBytes) {
      logger.log(
        `[ipatool] Using provided expected app size for progress tracking: ${Math.ceil(expectedSizeBytes / BYTES_PER_MB)} MB`,
      );
    }

    if (!expectedSizeBytes) {
      // Percentage is disabled, NOT liveness: the stall timer still gets fed by
      // the poller's file fingerprint, or a sizeless download would be killed.
      logger.warn(`[ipatool] No expected size available - progress percentage will be disabled`);
    }

    const suppressHUD = options?.suppressHUD ?? false;
    // Platform decides both the ipatool flag and the on-disk file layout the
    // progress poller watches; macOS uses a different pipeline and container.
    const platform: DownloadPlatform = options?.platform ?? "iphone";
    const layout = layoutForPlatform(platform);
    const { maxDownloadTimeout, maxStallTimeout } = getConfig();

    // ONE claim for the whole logical download. Every retry and the re-download
    // after an automatic license purchase run inside it; none of them takes it
    // again. Keying "should I lock" on `retryCount === 0` used to make the
    // post-purchase re-download (which restarts at 0) refuse itself.
    const lock = acquireDownloadLock(downloadsDir, bundleId, platform);
    // Release protection starts on the very next line. Anything awaited between
    // acquiring and the `try` — a HUD, say — could otherwise reject and strand
    // the lock.
    try {
      return await runDownloadAttempts(
        {
          bundleId,
          appName,
          appVersion,
          price,
          downloadsDir,
          platform,
          layout,
          suppressHUD,
          onProgress: options?.onProgress,
          expectedSizeBytes,
          maxDownloadTimeout,
          maxStallTimeout,
          lock,
        },
        retryCount,
        retryDelay,
      );
    } finally {
      lock.release();
    }
  } catch (error) {
    // Another Raycast command already owns this bundle's download. This is a
    // normal collision, not a failure: say so plainly and do not log a stack.
    // The callers say so in their own voice (a toast, an AI tool result); a HUD
    // here only duplicated that, and a rejecting one replaced the typed error.
    if (error instanceof DownloadInProgressError) {
      logger.log(`[ipatool] Download refused: ${bundleId} is already in progress elsewhere`);
      throw error;
    }

    // Let authentication errors bubble up to be handled by the calling code
    if (error instanceof NeedsLoginError || error instanceof Needs2FAError) {
      logger.error(`[ipatool] Authentication error during download: ${error.message}`);
      throw error; // Re-throw to let the hook handle it with navigation
    }

    logger.error(`[ipatool] Unhandled download error: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      logger.error(`[ipatool] Error stack: ${error.stack}`);
    }
    logger.error(`[ipatool] Error details:`, error);
    // Re-throw to let callers handle HUD/toasts consistently and avoid duplicates
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Everything one logical download needs, fixed for all of its attempts. */
interface DownloadContext {
  bundleId: string;
  appName: string;
  appVersion: string;
  price: string;
  downloadsDir: string;
  platform: DownloadPlatform;
  layout: DownloadLayout;
  suppressHUD: boolean;
  onProgress?: (progress: number) => void;
  expectedSizeBytes?: number;
  maxDownloadTimeout: number;
  maxStallTimeout: number;
  lock: DownloadLock;
}

/** What may still happen after this attempt. */
interface AttemptPolicy {
  attempt: number;
  retryDelay: number;
  /** An automatic license purchase is tried at most once per download. */
  allowPurchase: boolean;
  /** A corrupted file is re-downloaded at most once per download. */
  allowIntegrityRetry: boolean;
}

/**
 * How an attempt ended. An attempt never recurses and never decides anything
 * about the attempts after it — it reports, and `runDownloadAttempts` acts.
 */
type AttemptOutcome =
  | { kind: "done"; filePath: string | undefined }
  | { kind: "failed"; error: Error }
  | {
      kind: "retry";
      waitMs: number;
      nextAttempt: number;
      nextDelay: number;
      afterPurchase?: boolean;
      afterCorruption?: boolean;
    };

/** How the ipatool child ended. Settled exactly once. */
type DownloadRun =
  | {
      type: "close";
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      stalled: boolean;
    }
  | { type: "error"; error: Error; stdout: string; stderr: string };

/** A HUD that can never reject into a download: a failed notice is not a failed download. */
function hudFor(suppressHUD: boolean): (message: string) => Promise<void> {
  return async (message) => {
    if (suppressHUD) return;
    try {
      await showHUD(message);
    } catch (error) {
      logger.warn(`[ipatool] Could not show HUD "${message}":`, error);
    }
  };
}

/**
 * Runs attempts until one finishes, fails terminally, or retries run out.
 *
 * This replaced retrying by calling `downloadApp` from INSIDE the child's
 * `close` listener. An EventEmitter does not await its listeners, so when that
 * nested call rejected, the rejection went nowhere: the original download's
 * promise stayed pending forever, its `finally` never released the lock, and
 * Raycast's unhandled-rejection handler then killed the command. A plain loop
 * has none of that — every outcome is a return value.
 */
async function runDownloadAttempts(
  ctx: DownloadContext,
  firstAttempt: number,
  firstDelay: number,
): Promise<string | null | undefined> {
  let policy: AttemptPolicy = {
    attempt: firstAttempt,
    retryDelay: firstDelay,
    allowPurchase: true,
    allowIntegrityRetry: firstAttempt === 0,
  };

  for (let isFirst = true; ; isFirst = false) {
    // A retry can follow a long backoff, and every retry used to re-enter
    // `downloadApp` and re-check the session; keep that.
    if (!isFirst && !(await ensureAuthenticated())) return null;

    const outcome = await runDownloadAttempt(ctx, policy);
    if (outcome.kind === "done") return outcome.filePath;
    if (outcome.kind === "failed") throw outcome.error;

    if (outcome.waitMs > 0) {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, outcome.waitMs));
    }
    policy = {
      attempt: outcome.nextAttempt,
      retryDelay: outcome.nextDelay,
      allowPurchase: policy.allowPurchase && !outcome.afterPurchase,
      allowIntegrityRetry: policy.allowIntegrityRetry && !outcome.afterCorruption,
    };
  }
}

/**
 * One ipatool run, in its own operation directory, which is always deleted when
 * the attempt ends. A successful attempt has already renamed its artifact out
 * of it by then. Never throws: every failure is an `AttemptOutcome`.
 */
async function runDownloadAttempt(ctx: DownloadContext, policy: AttemptPolicy): Promise<AttemptOutcome> {
  const { bundleId, appName, platform, price } = ctx;
  const hud = hudFor(ctx.suppressHUD);
  let operationDir: string | undefined;

  try {
    // A fresh directory per attempt also replaces the sweep that used to run
    // before every attempt: ipatool resumes from a leftover `.ipa.tmp` and a
    // corrupted one produced "negative offset" errors. A new directory has no
    // leftovers to resume from.
    operationDir = createOperationDirectory(ctx.downloadsDir);
    registerTempFile(operationDir);

    const retryInfo = policy.attempt > 0 ? ` (Attempt ${policy.attempt + 1}/${MAX_RETRIES + 1})` : "";
    await hud(`Downloading ${appName || bundleId}${retryInfo}...`);

    // Check if the app is paid based on price value
    const isPaidApp = price && parseFloat(price) > 0;
    logger.log(
      `[ipatool] Downloading app: ${appName || bundleId}, isPaidApp: ${isPaidApp}, price: ${price}${retryInfo}`,
    );

    const args = ["download", "-b", bundleId, "-o", operationDir, "--format", "json", "--non-interactive", "--verbose"];

    // Only sent when it is not the default. Omitting it leaves ipatool's own
    // platform resolution in charge, which is what has always worked for
    // universal and iPad-only apps (Procreate is iPad-only and downloads fine
    // today with no flag) — forcing `--platform iphone` onto those would be a
    // behavior change dressed up as explicitness.
    if (platform !== "iphone") {
      logger.log(`[ipatool] Adding --platform ${platform}`);
      args.push("--platform", platform);
    }

    // Add purchase flag for paid apps
    if (isPaidApp) {
      logger.log("Adding --purchase flag for paid app");
      args.push("--purchase");
    }

    logger.log(`[ipatool] Executing download command: ${IPATOOL_PATH} ${args.join(" ")}`);

    const child = await createSecureIpatoolProcess(args, {
      timeout: ctx.maxDownloadTimeout,
      allowedCommands: ["download"],
    });
    const run = await watchDownload(child, ctx, operationDir);
    return await interpretDownload(ctx, policy, run, operationDir);
  } catch (error) {
    logger.error(`[ipatool] Download attempt failed:`, error);
    return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    if (operationDir) {
      removeOperationDirectory(operationDir);
      unregisterTempFile(operationDir);
    }
  }
}

/**
 * Feeds progress and the stall watchdog while ipatool runs, and resolves once,
 * when the child is gone.
 *
 * The watchdog only STOPS the writer. It never settles the attempt and never
 * touches files; the `close` that follows is the single place the attempt ends.
 * It used to register a second `close` listener that rejected while the first
 * one went on to retry or rename, so one stalled download could be reported as
 * stalled AND finish publishing its file afterwards.
 */
function watchDownload(child: ChildProcess, ctx: DownloadContext, operationDir: string): Promise<DownloadRun> {
  const { bundleId, appName, layout, expectedSizeBytes } = ctx;
  const hud = hudFor(ctx.suppressHUD);

  return new Promise<DownloadRun>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stalled = false;
    let lastProgress = 0;
    let lastReportedSize = 0;
    // Liveness fingerprint, separate from lastReportedSize: the sorted
    // `name:size` of every file in the operation directory. ANY difference — a
    // file growing, appearing, shrinking or being deleted — is proof the
    // writer is alive, so every phase resets the stall timer even when the
    // percentage does not move.
    //
    // This is deliberately NOT a monotonic byte watermark. A watermark only
    // rises, so the phase where temps COLLAPSE into the final artifact (macOS:
    // encrypted + decrypted, ~2x, becoming a 1x `.pkg`) reduces the total and
    // therefore registers as no progress at all — the stall timer would then
    // run unreset through finalization.
    let lastFingerprint = "";
    let stallTimer: NodeJS.Timeout | undefined;

    const finish = (run: DownloadRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      clearInterval(progressCheckInterval);
      resolve(run);
    };

    const onStall = () => {
      stalled = true;
      clearInterval(progressCheckInterval);
      logger.error(`[ipatool] Download stalled after ${ctx.maxStallTimeout / 1000} seconds without progress.`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (settled) return;
        logger.log(`[ipatool] Stalled process ignored SIGTERM, escalating to SIGKILL`);
        child.kill("SIGKILL");
        // If `close` still never arrives (something holding ipatool's pipes
        // open), end the attempt anyway rather than hang. That is safe only
        // because the operation directory is private: a writer we failed to
        // reap can keep writing, but into a directory nothing else reads, and
        // it is deleted with the attempt.
        setTimeout(() => finish({ type: "close", code: null, signal: "SIGKILL", stdout, stderr, stalled }), 2000);
      }, 5000);
    };

    const resetStallTimer = () => {
      if (stalled || settled) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(onStall, ctx.maxStallTimeout);
    };

    logger.log(
      `[ipatool] Starting progress tracking interval. expectedSizeBytes: ${expectedSizeBytes}, bundleId: ${bundleId}`,
    );

    // Declared after `finish`/`onStall`, which close over it; neither can run
    // before this line, because the stall timer is first armed below.
    const progressCheckInterval = setInterval(() => {
      try {
        // ipatool never writes the final artifact straight through, and the
        // intermediate layout differs per platform (see
        // `utils/download-layout.ts`):
        //
        //   iOS    bytes land in `.ipa.tmp`, then the real `.ipa` is
        //          assembled from it (the repack that injects artwork)
        //   macOS  bytes land in `.pkg.ipatool-encrypted`, then
        //          `.pkg.ipatool-decrypted` appears ALONGSIDE it, then
        //          both collapse into the final `.pkg`
        //
        // Matching only the final suffix therefore saw NOTHING for the whole
        // network phase and reported no progress at all. Several of these
        // files exist at once, so watch them ALL and drive the percentage off
        // whichever is furthest along.
        //
        // The operation directory holds only this attempt's files, so there is
        // no bundle prefix to match and nothing another download writes can be
        // mistaken for this one's liveness.
        let tmpSize = 0;
        let finalSize = 0;
        const fingerprintParts: string[] = [];
        for (const file of fs.readdirSync(operationDir)) {
          // No temp suffix ENDS with the final suffix (`.ipa.tmp` and
          // `.pkg.ipatool-encrypted` both extend it rather than closing with
          // it), so the two tests are disjoint and the order is for
          // readability, not correctness. `download-layout.test.mjs` asserts
          // that disjointness against real observed filenames.
          const isTmp = layout.temps.some((suffix) => file.endsWith(suffix));
          if (!isTmp && !file.endsWith(layout.final)) continue;
          const size = fs.statSync(path.join(operationDir, file)).size;
          if (isTmp) tmpSize = Math.max(tmpSize, size);
          else finalSize = Math.max(finalSize, size);
          fingerprintParts.push(`${file}:${size}`);
        }

        // Any change in ANY of those files is liveness, even when it buys no
        // percentage points. The iOS repack writes only the final `.ipa` while
        // the `.tmp` sits at full size, and the macOS decrypt writes only
        // `.pkg.ipatool-decrypted` while the encrypted file sits at full size —
        // scoring either as "no progress" let the stall timer kill a download
        // that was seconds from succeeding.
        const fingerprint = fingerprintParts.sort().join("|");
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          resetStallTimer();
        }

        // Percentage needs a denominator; liveness above does not. An app
        // whose iTunes lookup returned no `fileSizeBytes`, or a retry (which
        // does not re-fetch it), therefore still keeps the stall timer fed
        // instead of being killed mid-download.
        if (!expectedSizeBytes) return;

        const currentSize = Math.max(tmpSize, finalSize);
        if (currentSize > 0) {
          // Only report progress if file size has changed significantly (every 512KB or at completion)
          // Using 512KB threshold to catch progress on faster downloads
          const shouldReport = currentSize > lastReportedSize + 512 * 1024 || currentSize === expectedSizeBytes;

          if (shouldReport) {
            const progress = Math.min(currentSize / expectedSizeBytes, 1.0);

            if (progress > lastProgress) {
              lastProgress = progress;

              // Call progress callback if provided (callback will handle logging)
              ctx.onProgress?.(progress);

              void hud(`Downloading ${appName || bundleId}... ${Math.round(progress * 100)}%`);

              lastReportedSize = currentSize;
            }
          }
        }
      } catch (error) {
        logger.warn(`[ipatool] Error checking download progress:`, error);
      }
    }, 250); // Check every 250ms for more responsive progress updates

    resetStallTimer(); // Initialize stall timer

    child.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      logger.log(`[ipatool] stdout: ${chunk.trim()}`);
    });

    child.stderr?.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      logger.error(`[ipatool] stderr: ${chunk.trim()}`);

      // Log specific error types for better debugging
      if (chunk.includes("network") || chunk.includes("connection") || chunk.includes("tls")) {
        logger.error(`[ipatool] Network-related error detected: ${chunk.trim()}`);
      } else if (chunk.includes("authentication") || chunk.includes("login")) {
        logger.error(`[ipatool] Authentication error detected: ${chunk.trim()}`);
      }
    });

    // Node emits (code, signal) on close — when the process exits normally,
    // `code` is the exit status and `signal` is null; when it's killed by a
    // signal (timeout watchdog, stall watchdog, OS kill, Raycast reload),
    // `code` is null and `signal` carries the signal name (e.g. "SIGTERM").
    child.on("close", (code, signal) => {
      logger.log(`[ipatool] Download process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`);

      // Land on 100%. The denominator is Apple's `fileSizeBytes`, which is the
      // INSTALLED size, not the archive — Muse reports 111 MB and ships an 85
      // MB IPA — so the poller's last honest reading is whatever fraction the
      // IPA happens to be of that (76%, there). The bar then just stops.
      // ipatool exiting 0 is the only real completion signal we get, so use it.
      if (code === 0 && lastProgress < 1) {
        lastProgress = 1;
        try {
          ctx.onProgress?.(1);
        } catch (error) {
          // A listener's callback throwing must not stop the attempt settling.
          logger.warn(`[ipatool] Progress callback threw:`, error);
        }
        void hud(`Downloading ${appName || bundleId}... 100%`);
      }

      finish({ type: "close", code, signal, stdout, stderr, stalled });
    });

    child.on("error", (error) => {
      finish({ type: "error", error, stdout, stderr });
    });
  });
}

/**
 * Decides what a finished ipatool run means: publish, retry, or fail. Runs only
 * after the child is gone, so nothing here races the writer.
 */
async function interpretDownload(
  ctx: DownloadContext,
  policy: AttemptPolicy,
  run: DownloadRun,
  operationDir: string,
): Promise<AttemptOutcome> {
  const { bundleId, appName, appVersion, price, platform, layout } = ctx;
  const { attempt, retryDelay } = policy;
  const hud = hudFor(ctx.suppressHUD);

  if (run.type === "error") {
    const { error } = run;
    logger.error(`[ipatool] Process error during download: ${error.message}`);

    // Check if this is a TLS error or other network error that might be transient
    const isTlsError =
      error.message.includes("tls: bad record MAC") ||
      error.message.includes("network error") ||
      error.message.includes("connection reset");

    // If we have retries left and it's a TLS error, retry with backoff
    if (isTlsError && attempt < MAX_RETRIES) {
      logger.log(
        `[ipatool] TLS/Network error detected in process error handler. Retrying in ${retryDelay}ms (Attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await hud(`Network error. Retrying in ${Math.round(retryDelay / 1000)}s...`);
      return { kind: "retry", waitMs: retryDelay, nextAttempt: attempt + 1, nextDelay: retryDelay * 1.5 };
    }

    await hud("Download failed");
    // shouldThrow=false: the outcome carries the error to the caller.
    await handleDownloadError(error, "download app", "downloadApp", false);
    return { kind: "failed", error };
  }

  const { code, signal, stdout, stderr } = run;

  // Only log full output in development or when there's an error
  if (process.env.NODE_ENV === "development" || code !== 0) {
    logger.log(`[ipatool] Full stdout: ${stdout}`);
    logger.log(`[ipatool] Full stderr: ${stderr}`);
  }

  if (code !== 0) {
    logger.error(
      `[ipatool] Download failed with code ${code}${signal ? ` (signal: ${signal})` : ""}. Error: ${stderr}`,
    );
    logger.error(`[ipatool] Full stdout content: "${stdout}"`);

    // The watchdog killed it. Report that, rather than letting the killed
    // process's stderr be classified as a network error and retried.
    if (run.stalled) {
      return { kind: "failed", error: new Error("Download stalled.") };
    }

    // Parse JSON output from stdout to get specific error information.
    // If the process was killed by a signal, code is null and we
    // describe what actually happened instead of "code null".
    const errorMessage = signal
      ? signal === "SIGTERM"
        ? `Download stopped before completing (terminated). This usually means it stalled, timed out, or was interrupted.`
        : `Download stopped before completing (signal: ${signal}).`
      : `Process exited with code ${code}`;
    let specificError = "";

    try {
      // ipatool often outputs multiple JSON lines, check each line
      const lines = stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim());
      for (const line of lines) {
        if (line.includes('"error"')) {
          const jsonData = JSON.parse(line);
          if (jsonData.error) {
            specificError = jsonData.error;
            logger.error(`[ipatool] Parsed error from JSON: ${specificError}`);
            break;
          }
        }
      }
    } catch (parseError) {
      logger.error(`[ipatool] Could not parse JSON from stdout: ${parseError}`);
    }

    // Check if this is a network error that might be transient.
    //
    // The STRUCTURED error wins. `--verbose` makes ipatool dump the whole HTTP
    // conversation to stderr, and a single `Connection:` response header was
    // enough to classify a flat refusal — a platform mismatch, say — as
    // transient and retry it three times before reporting the wrong cause.
    // Only fall back to scanning the raw stream when ipatool gave us nothing
    // structured.
    const networkSignals = ["tls", "network", "connection", "bad record mac"];
    const isNetworkError = specificError
      ? networkSignals.some((networkSignal) => specificError.toLowerCase().includes(networkSignal))
      : networkSignals.some((networkSignal) => stderr.toLowerCase().includes(networkSignal));

    if (isNetworkError && attempt < MAX_RETRIES) {
      logger.log(
        `[ipatool] Network/TLS error detected: "${specificError}". Retrying in ${retryDelay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await hud(`Network error. Retrying in ${Math.round(retryDelay / 1000)}s...`);
      return {
        kind: "retry",
        waitMs: retryDelay,
        nextAttempt: attempt + 1,
        nextDelay: Math.min(retryDelay * 1.5, MAX_RETRY_DELAY),
      };
    }

    // Use precise ipatool error analysis for categorization.
    //
    // Two bugs lived in the old `stderr || specificError || errorMessage`:
    // stderr is essentially never empty under `--verbose`, so the error ipatool
    // actually reported in stdout JSON was always discarded; and passing that
    // same stderr as BOTH arguments made the analyzer concatenate it with
    // itself ("invalid response invalid response"), which fails every anchored
    // pattern and degraded a precise classification into a generic one.
    const primaryError = specificError || stderr || errorMessage;
    const supportingStderr = stderr && stderr !== primaryError ? stderr : undefined;
    const errorAnalysis = analyzeIpatoolError(primaryError, supportingStderr);

    // Check if this is a timeout/stall error that can be retried
    if (errorAnalysis.errorType === "timeout" && attempt < MAX_RETRIES) {
      logger.log(
        `[ipatool] Timeout/stall error detected. Retrying in ${retryDelay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await hud(`Download stalled. Retrying in ${Math.round(retryDelay / 1000)}s...`);
      return {
        kind: "retry",
        waitMs: retryDelay,
        nextAttempt: attempt + 1,
        nextDelay: Math.min(retryDelay * 1.5, MAX_RETRY_DELAY),
      };
    }

    // Retry for rate limiting or maintenance downtime with extended backoff
    if (
      (errorAnalysis.errorType === "rate_limited" || errorAnalysis.errorType === "maintenance") &&
      attempt < MAX_RETRIES
    ) {
      const baseDelay = Math.max(retryDelay, 5000);
      const label = errorAnalysis.errorType === "rate_limited" ? "Rate limited" : "App Store maintenance";
      logger.log(
        `[ipatool] ${label} detected. Retrying in ${Math.round(baseDelay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await hud(
        `${errorAnalysis.errorType === "rate_limited" ? "Rate limited" : "Maintenance"} – retrying in ${Math.round(baseDelay / 1000)}s...`,
      );
      return {
        kind: "retry",
        waitMs: baseDelay,
        nextAttempt: attempt + 1,
        nextDelay: Math.min(Math.floor(baseDelay * 1.5), 30000),
      };
    }

    // Apple answered 200 with an empty product payload for this specific app.
    // Terminal and app-specific — typed so the caller says so rather than
    // re-deriving it from a wrapped string.
    if (errorAnalysis.errorType === "apple_empty_response") {
      logger.error(`[ipatool] Apple returned an empty payload for ${appName || bundleId} — see majd/ipatool#538`);
      return { kind: "failed", error: new AppleEmptyResponseError(errorAnalysis.userMessage) };
    }

    if (errorAnalysis.errorType === "apple_auth_gate") {
      logger.error(`[ipatool] Apple auth gate hit for ${appName || bundleId}: ${errorAnalysis.userMessage}`);
      return { kind: "failed", error: new AppleAuthGateError(errorAnalysis.userMessage) };
    }

    // Use the analyzed error message and routing. Several userMessages open
    // with a literal "App" standing in for the app's name — swap in the real
    // one.
    //
    // ANCHORED AND WORD-BOUNDED ON PURPOSE. A bare `.replace("App", name)`
    // matches the first "App" ANYWHERE, including inside "Apple": it turned
    // "unexpected response from Apple (HTTP 403)" into `unexpected response
    // from "Tolan: Your Friendly Guide"le (HTTP 403)`. The `(?! Store)` guard
    // keeps "App Store is temporarily unavailable" intact — there "App" names
    // Apple's store, not this app.
    let finalErrorMessage = errorAnalysis.userMessage.includes(appName || bundleId)
      ? errorAnalysis.userMessage
      : // Callback form on purpose: a plain string replacement would let `$&` /
        // `$'` inside an app NAME be interpreted as replacement metacharacters
        // and echo the match back instead of the name.
        errorAnalysis.userMessage.replace(/^App(?! Store)\b/, () => `"${appName || bundleId}"`);

    // Check if this is a license required error for a free app
    if (errorAnalysis.isLicenseRequired && isFreeApp(price)) {
      if (isAppleBuiltInApp(bundleId)) {
        logger.log(
          `[ipatool] License required for built-in Apple app ${appName || bundleId}; the Store will not license these to ipatool.`,
        );

        // Typed, so the caller states the reason plainly rather than letting
        // the generic analyzer wrap it as "Download failed:".
        return { kind: "failed", error: new BuiltInAppError(builtInAppMessage(appName || bundleId)) };
      } else if (!policy.allowPurchase) {
        // Already purchased once during this download and Apple still says a
        // license is required. Report it instead of buying in a loop.
        logger.log(`[ipatool] License still required for ${appName || bundleId} after a successful purchase`);
      } else {
        logger.log(`[ipatool] License required for free app ${appName || bundleId}. Attempting automatic purchase...`);

        try {
          const purchaseResult = await purchaseApp(bundleId, appName, { suppressHUD: ctx.suppressHUD, platform });

          if (purchaseResult.success) {
            logger.log(`[ipatool] License purchase successful for ${appName || bundleId}. Retrying download...`);
            await hud(`License obtained. Retrying download...`);

            // A fresh start, inside the SAME lock this download already holds.
            return {
              kind: "retry",
              waitMs: 0,
              nextAttempt: 0,
              nextDelay: INITIAL_RETRY_DELAY,
              afterPurchase: true,
            };
          } else {
            logger.log(
              `[ipatool] License purchase failed for ${appName || bundleId} (${purchaseResult.errorType}). Proceeding with error handling.`,
            );
            await hud(`Failed to obtain license for ${appName || bundleId}`);

            // Surface the purchase error's own classification rather than
            // guessing. Rate limiting (ipatool#480 plist error) is the common
            // case for some apps and is transient.
            if (purchaseResult.errorType === "rate_limited") {
              finalErrorMessage = `Could not get a license for "${appName || bundleId}" — Apple rate-limited the request. Please wait a few minutes and try again.`;
            } else if (purchaseResult.userMessage) {
              finalErrorMessage = `Could not get a license for "${appName || bundleId}": ${purchaseResult.userMessage}`;
            } else {
              finalErrorMessage = `License purchase failed for free app "${appName || bundleId}". This may be due to App Store restrictions.`;
            }
          }
        } catch (purchaseError) {
          // Typed errors pass through unchanged so the hook's typed branches
          // see them instead of a wrapped string: Apple's gate and empty
          // payload are terminal, an auth failure (expired token, changed
          // password) redirects to sign-in, and a pre-release app gets the
          // specific "Not Released Yet" toast.
          if (purchaseError instanceof AppleEmptyResponseError) {
            logger.error(`[ipatool] Apple returned an empty payload purchasing ${appName || bundleId}`);
            return { kind: "failed", error: purchaseError };
          }

          if (purchaseError instanceof AppleAuthGateError) {
            logger.error(`[ipatool] Apple auth gate during license purchase for ${appName || bundleId}`);
            return { kind: "failed", error: purchaseError };
          }

          if (purchaseError instanceof Needs2FAError) {
            logger.error(`[ipatool] 2FA required during license purchase for ${appName || bundleId}`);
            return { kind: "failed", error: purchaseError };
          }

          if (purchaseError instanceof Error && purchaseError.name === "NeedsLoginError") {
            logger.error(`[ipatool] Auth required during license purchase for ${appName || bundleId}`);
            return { kind: "failed", error: purchaseError };
          }

          if (purchaseError instanceof NotYetReleasedError) {
            logger.log(`[ipatool] Pre-release surfaced during license purchase for ${appName || bundleId}`);
            return { kind: "failed", error: purchaseError };
          }

          logger.error(`[ipatool] Error during license purchase attempt:`, purchaseError);
          await hud(`License purchase error for ${appName || bundleId}`);

          // Update the error message to include the purchase error details
          const purchaseErrorMsg = purchaseError instanceof Error ? purchaseError.message : String(purchaseError);
          finalErrorMessage = `License purchase failed for free app "${appName || bundleId}": ${purchaseErrorMsg}`;
        }
      }
    }

    // Apple expired the session token, ipatool re-signed in with the stored
    // password, and Apple answered with a 2FA prompt on the user's devices.
    // The code on screen finishes that sign-in, so this routes to the code
    // form, not the password form. The message must not contain
    // "authentication required": `handleAuthError` treats that phrase as bad
    // credentials and deletes the stored password the code form needs.
    if (errorAnalysis.is2FARequired) {
      logger.log(`[ipatool] Apple asked for a 2FA code while downloading ${appName || bundleId}`);
      return { kind: "failed", error: new Needs2FAError(TWO_FACTOR_PROMPT_MESSAGE) };
    }

    // Route to appropriate error handler based on analysis
    if (errorAnalysis.isAuthError) {
      // NeedsLoginError lets the hook handle it with navigation
      return { kind: "failed", error: new NeedsLoginError(finalErrorMessage) };
    }
    if (errorAnalysis.errorType === "not_yet_released") {
      // Pre-release / Coming Soon: surface as typed error so the hook can
      // show "Not Released Yet" without re-parsing the wrapped message.
      return { kind: "failed", error: new NotYetReleasedError(finalErrorMessage) };
    }
    // shouldThrow=false: the outcome carries the error to the caller.
    await handleDownloadError(new Error(finalErrorMessage), "download app", "downloadApp", false);
    return { kind: "failed", error: new Error(finalErrorMessage) };
  }

  // Try to find a JSON object in the output
  let filePath = "";

  // Look for JSON object in the output
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const jsonOutput = safeJsonParse<{ output: string }>(line, { output: "" });
        if (jsonOutput.output) {
          filePath = jsonOutput.output;
          logger.log(`[ipatool] Found file path in JSON output: ${filePath}`);
          break;
        }
      } catch (e) {
        logger.error("Error parsing JSON line:", e);
        // Continue to next line if this one fails
      }
    }
  }

  // If no filePath found in JSON, try to extract it from the stdout
  if (!filePath) {
    logger.log("[ipatool] No JSON output found, trying to extract file path from stdout using regex patterns");
    filePath = extractFilePath(stdout, "");
  }

  // Keep a parsed path only if it names a finished artifact that exists. The
  // regex extractor is `.ipa`-only and matches INSIDE `.ipatool`, so a Mac line
  // like `saved to …/a.pkg.ipatool-encrypted` yields a bogus `…/a.pkg.ipa`.
  // Accepting it skipped the scan below and threw away the real `.pkg`.
  if (filePath && !(filePath.endsWith(layout.final) && fs.existsSync(filePath))) {
    logger.warn(`[ipatool] Ignoring parsed path that is not a finished artifact: ${filePath}`);
    filePath = "";
  }

  // Last resort: whatever finished artifact is in the operation directory. It
  // holds only this attempt's output, so — unlike scanning the shared downloads
  // directory, as this used to — it cannot adopt an older download of the same
  // app, or a different app's file, as this one's result.
  if (!filePath) {
    try {
      const artifact = fs.readdirSync(operationDir).find((file) => file.endsWith(layout.final));
      if (artifact) {
        filePath = path.join(operationDir, artifact);
        logger.log(`[ipatool] Found the finished artifact in the operation directory: ${filePath}`);
      }
    } catch (e) {
      logger.error("Error reading the operation directory:", e);
    }
  }

  logger.log(`[ipatool] Original downloaded file path: ${filePath}`);

  if (!filePath || !fs.existsSync(filePath)) {
    logger.error(`[ipatool] ipatool reported success but no downloaded file was found`);
    return { kind: "done", filePath: undefined };
  }

  // Verify file integrity before publishing
  logger.log(`[ipatool] Starting file integrity verification for ${appName || bundleId}`);

  // Parse any JSON metadata from stdout for integrity verification
  let ipatoolJsonData = null;
  try {
    for (const line of stdout.trim().split("\n")) {
      if (line.trim().startsWith("{") && line.trim().endsWith("}")) {
        const parsedJson = JSON.parse(line);
        if (parsedJson && (parsedJson.fileSize || parsedJson.checksum)) {
          ipatoolJsonData = parsedJson;
          logger.log(`[ipatool] Found metadata for integrity check:`, ipatoolJsonData);
          break;
        }
      }
    }
  } catch {
    logger.log(`[ipatool] No valid JSON metadata found for integrity verification`);
  }

  const integrityResult = await verifyFileIntegrity(filePath, appName, ipatoolJsonData);

  if (!integrityResult.isValid) {
    // The corrupted file goes with the operation directory; no unlink needed.
    logger.error(`[ipatool] File integrity verification failed: ${integrityResult.errorMessage}`);
    await handleDownloadError(
      new Error(`Downloaded file is corrupted: ${integrityResult.errorMessage}`),
      "verify downloaded file",
      "downloadApp",
      false,
    );

    // Optional automatic retry (once) for corrupted files
    if (integrityResult.shouldRetry && policy.allowIntegrityRetry) {
      logger.log(`[ipatool] Attempting automatic retry for corrupted file`);
      await hud(`File corrupted. Retrying download...`);
      return {
        kind: "retry",
        waitMs: 2000,
        nextAttempt: 1,
        nextDelay: INITIAL_RETRY_DELAY,
        afterCorruption: true,
      };
    }

    return { kind: "failed", error: new Error(`File integrity verification failed: ${integrityResult.errorMessage}`) };
  }

  logger.log(`[ipatool] ✓ File integrity verification passed for ${appName || bundleId}`);

  // Publish: move the artifact out of the operation directory into the
  // downloads directory. Both are on one filesystem, so this is a single atomic
  // rename — never a copy — and it replaces an existing file of the same name
  // in one step, where the old unlink-then-rename left a window with neither.
  const currentFileName = path.basename(filePath);
  let publishedName = currentFileName;
  if (appName && appVersion) {
    // Clean the app name by removing marketing terms, then replace invalid
    // filename characters with a dash
    const sanitizedAppName = cleanAppNameForFilename(appName).replace(/[/\\?%*:|"<>]/g, "-");
    // Taken from the artifact, not the platform: a `.pkg` must not be renamed
    // to `.ipa`, and a future platform cannot get it wrong.
    const ext = path.extname(currentFileName) || layout.final;
    publishedName = `${sanitizedAppName} ${appVersion}${ext}`;
  }

  for (const candidate of new Set([publishedName, currentFileName])) {
    const destination = path.join(ctx.downloadsDir, candidate);
    try {
      if (fs.existsSync(destination)) {
        logger.warn(`[ipatool] Replacing existing file: ${destination}`);
      }
      fs.renameSync(filePath, destination);
      logger.log(`[ipatool] Published ${appName || bundleId} to: ${destination}`);
      // Announced only now. It used to fire as soon as ipatool exited, before
      // the file was found, verified, or saved — so a corrupted or unsaveable
      // download said "complete" and then failed.
      await hud("Download complete");
      return { kind: "done", filePath: destination };
    } catch (e) {
      logger.error(`[ipatool] Could not publish to ${destination}:`, e);
    }
  }

  // Neither name worked. The file is about to be deleted with the operation
  // directory, so returning its path would hand the caller a file that is gone.
  return { kind: "failed", error: new Error(`Could not save the downloaded file to ${ctx.downloadsDir}`) };
}

/**
 * Get detailed information about an app
 * @param bundleId Bundle ID of the app
 * @returns App details object
 */
export async function getAppDetails(bundleId: string) {
  try {
    logger.log(`[ipatool] Getting app details for bundleId: ${bundleId}`);

    // Ensure we're authenticated before proceeding
    const isAuthenticated = await ensureAuthenticated();
    if (!isAuthenticated) {
      await handleAuthError(
        new Error("Authentication required for app details lookup. Sign in with your Apple ID."),
        false,
      );
      return null;
    }

    // Try to get details directly from iTunes API first
    logger.log(`[ipatool] Trying to fetch details directly from iTunes API for ${bundleId}`);
    const itunesDetails = await fetchITunesAppDetails(bundleId);

    if (itunesDetails) {
      logger.log(`[ipatool] Successfully retrieved details from iTunes API for ${bundleId}`);

      // Use the utility function to convert iTunes data to AppDetails
      const result = convertITunesResultToAppDetails(itunesDetails);

      logger.log(`[ipatool] Successfully parsed app details from iTunes API for ${bundleId}`);
      return result;
    }

    // If iTunes API fails, fall back to ipatool search
    logger.log(`[ipatool] iTunes API lookup failed, falling back to ipatool search for ${bundleId}`);

    // Try a more general search if the bundle ID is very specific
    // This helps with cases where the exact bundle ID doesn't yield results
    let searchTerm = bundleId;
    // Ensure bundleId is defined before trying to split it
    if (bundleId && bundleId.split(".").length > 2) {
      // Extract the app name part from the bundle ID (usually the last part)
      const bundleParts = bundleId.split(".");
      const possibleAppName = bundleParts[bundleParts.length - 1];
      if (possibleAppName && possibleAppName.length > 3) {
        searchTerm = possibleAppName;
        logger.log(`[ipatool] Using extracted app name from bundle ID: ${searchTerm}`);
      }
    }

    // Execute the search command using execFile to prevent command injection
    logger.log(`[ipatool] Executing search for term: ${searchTerm}`);
    const { stdout } = await execFileAsync(IPATOOL_PATH, [
      "search",
      searchTerm,
      "-l",
      "20",
      "--format",
      "json",
      "--non-interactive",
    ]);

    // Parse the JSON output with fallback to null if parsing fails
    logger.log(`[ipatool] Received search response, parsing JSON...`);
    const searchResponse = safeJsonParse<IpaToolSearchResponse>(stdout, { count: 0, apps: [] });

    if (!searchResponse.apps || searchResponse.apps.length === 0) {
      logger.log(`[ipatool] No apps found for search term: ${searchTerm}`);
      return null;
    }

    // Find the exact bundle ID match in the search results
    const exactMatch = searchResponse.apps.find((app) => (app.bundleId || app.bundleID) === bundleId);

    // If no exact match is found, use the first result as a fallback
    const app = exactMatch || searchResponse.apps[0];
    logger.log(
      `[ipatool] ${exactMatch ? "Found exact match" : "No exact match found, using first result"}: ${app.name} (${app.bundleId})`,
    );

    // Create a basic result with the data we have from ipatool search
    let result = convertIpaToolSearchAppToAppDetails(app);

    // Try to fetch additional details from iTunes API for the app we found
    const appBundleId = app.bundleId || app.bundleID || "";
    if (appBundleId !== bundleId && appBundleId) {
      logger.log(`[ipatool] Trying to fetch iTunes data for found app: ${appBundleId}`);
      const appItunesDetails = await fetchITunesAppDetails(appBundleId);

      if (appItunesDetails) {
        logger.log(`[ipatool] Enriching app details with iTunes data for ${app.bundleId}`);

        // Use the utility function to convert iTunes data to AppDetails
        result = convertITunesResultToAppDetails(appItunesDetails, result);
      } else {
        logger.log(`[ipatool] Could not fetch iTunes data for ${app.bundleId}, using basic details only`);
      }
    }

    logger.log(`[ipatool] Successfully parsed app details for ${bundleId}`);
    return result;
  } catch (error) {
    if (error instanceof IpatoolSetupError) {
      logger.error(`[ipatool] Setup failed while getting app details for ${bundleId}: ${error.message}`);
      return null;
    }

    logger.error(
      `[ipatool] Error getting app details for ${bundleId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (error instanceof Error && error.stack) {
      logger.error(`[ipatool] Error stack: ${error.stack}`);
    }
    logger.error(`[ipatool] Error details:`, error);
    await handleAppSearchError(error instanceof Error ? error : new Error(String(error)), bundleId, "getAppDetails");
    return null;
  }
}
