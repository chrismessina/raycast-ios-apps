import { useState } from "react";
import { showToast, Toast, showHUD, Clipboard, showInFinder } from "@raycast/api";
import { downloadApp, checkForExistingDownload } from "../ipatool";
import { handleDownloadError, handleAuthError } from "../utils/error-handler";
import { analyzeIpatoolError, type IpatoolErrorInfo } from "../utils/ipatool-error-patterns";
import { AuthNavigationHelpers } from "./use-auth-navigation";
import { NeedsLoginError, Needs2FAError, NotYetReleasedError, ensureAuthenticated } from "../utils/auth";
import { IpatoolSetupError } from "../utils/ipatool-validator";
import { logger } from "@chrismessina/raycast-logger";
import { useDownloadHistory } from "./use-download-history";
import type { AppDetails } from "../types";

// Global download state to prevent concurrent downloads across all hook instances
const globalDownloadState = {
  isAuthenticating: false,
  isDownloading: false,
  currentApp: null as string | null,
  activeOpId: null as string | null,
};

// Tracks how many times the sign-in form has been completed within a single
// download operation. ipatool's `unsupported protocol scheme` purchase failure
// (majd/ipatool#449) is classified as session_expired, which pushes the sign-in
// form — but for some apps/accounts re-login does NOT clear it. Without a cap,
// the user gets bounced to sign-in indefinitely. After one completed re-login,
// a still-failing auth error is treated as terminal instead.
const authAttemptsByOp = new Map<string, number>();

// Map an analyzed ipatool error type to the short toast/HUD title shown to the
// user. Auth errors are handled separately (they jump to the sign-in form
// instead of producing a generic toast). Anything not in this map falls back
// to "Download Failed".
const ERROR_TYPE_TITLES: Partial<Record<IpatoolErrorInfo["errorType"], string>> = {
  network: "Network Error",
  app_not_found: "App Not Found",
  rate_limited: "Rate Limited",
  maintenance: "App Store Maintenance",
  not_yet_released: "Not Released Yet",
  regional_restriction: "Region Restricted",
  account_restriction: "Account Restricted",
};

/**
 * Hook for downloading an app
 * @param authNavigation Optional auth navigation helpers for form redirects
 * @returns Object with download function and loading state
 */
export function useAppDownload(authNavigation?: AuthNavigationHelpers) {
  const [isLoading, setIsLoading] = useState(globalDownloadState.isDownloading || globalDownloadState.isAuthenticating);
  const [currentDownload, setCurrentDownload] = useState<string | null>(globalDownloadState.currentApp);
  const { addToHistory } = useDownloadHistory();

  /**
   * Download an app using ipatool
   * @param bundleId The bundle ID of the app to download
   * @param name The name of the app
   * @param version The version of the app
   * @param price The price of the app
   * @param showHudMessages Whether to show HUD messages during download
   * @param appDetails Full app details for history recording
   * @returns The path to the downloaded file or undefined if download failed
   */
  const handleDownload = async (
    bundleId: string,
    name: string,
    version: string,
    price: string,
    showHudMessages = true,
    opId?: string,
    expectedSizeBytes?: number,
    appDetails?: AppDetails,
  ): Promise<string | null | undefined> => {
    // Generate or reuse an operation ID for this logical download flow
    const operationId = opId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Concurrency gate: block other requests while authenticating or downloading
    if (globalDownloadState.activeOpId && globalDownloadState.activeOpId !== operationId) {
      if (globalDownloadState.isAuthenticating) {
        logger.log(
          `[useAppDownload] Authentication in progress for ${globalDownloadState.currentApp}. Blocking new request for ${name}.`,
        );
        // Avoid showing HUD/toast here to prevent premature window closure or noisy errors
        return undefined;
      }
      if (globalDownloadState.isDownloading) {
        logger.log(
          `[useAppDownload] Download in progress for ${globalDownloadState.currentApp}. Blocking new request for ${name}.`,
        );
        return undefined;
      }
    }

    // Acquire lock if this is a new operation
    if (!globalDownloadState.activeOpId) {
      globalDownloadState.activeOpId = operationId;
      globalDownloadState.currentApp = name;
      globalDownloadState.isAuthenticating = true;
    }

    // Update local state
    setIsLoading(true);
    setCurrentDownload(name);

    let releaseLock = true;
    let progressToast: Toast | undefined;

    // Single closure used by every "resume after auth" callback below. Capturing
    // the full call shape here (including expectedSizeBytes + appDetails) is the
    // forcing function: when handleDownload gains another parameter, exactly one
    // place needs to know about it. The five retry sites used to each repeat the
    // 8-arg call by hand, which is how appDetails went missing on resumes until
    // we noticed and threaded it through.
    const resumeDownload = () =>
      handleDownload(bundleId, name, version, price, showHudMessages, operationId, expectedSizeBytes, appDetails);

    try {
      // Pre-release / Coming Soon check.
      //
      // When the iTunes API reports a future releaseDate the app is listed but
      // cannot be downloaded — Apple's purchase API returns a generic
      // "temporarily unavailable" error that previously surfaced as misleading
      // "App Store maintenance". Bail out early with an accurate message
      // before pre-auth (no point bothering the user for credentials for an
      // app they can't get yet).
      if (appDetails?.releaseDate) {
        const releaseAt = new Date(appDetails.releaseDate);
        if (!isNaN(releaseAt.getTime()) && releaseAt > new Date()) {
          // Apple's convention for new-app release timestamps is midnight Pacific
          // (encoded as 07:00Z PDT / 08:00Z PST). Render in Los Angeles time so
          // users west of Pacific (Hawaii, Alaska, Samoa) don't see the prior
          // calendar day in the "Coming Soon" message.
          const formattedDate = releaseAt.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            timeZone: "America/Los_Angeles",
          });
          logger.log(
            `[useAppDownload] Pre-release skip: ${name} (${bundleId}) — releaseDate ${appDetails.releaseDate} is in the future.`,
          );
          if (showHudMessages) {
            await showToast({
              style: Toast.Style.Failure,
              title: "Not Released Yet",
              message: `${name} is expected ${formattedDate}.`,
            });
          }
          return null;
        }
      }

      // Pre-authenticate first so we can push forms without closing the window
      logger.log(
        `[useAppDownload] Pre-authentication start for ${name} (${bundleId}) – showHudMessages=${showHudMessages}`,
      );
      try {
        const authenticated = await ensureAuthenticated();
        if (!authenticated) {
          logger.log(`[useAppDownload] Pre-authentication did not complete for ${name} (${bundleId})`);
          return undefined;
        }
        logger.log(`[useAppDownload] Pre-authentication OK for ${name} (${bundleId})`);
        // Transition to downloading phase for this operation
        if (globalDownloadState.activeOpId === operationId) {
          globalDownloadState.isAuthenticating = false;
          globalDownloadState.isDownloading = true;
        }
      } catch (error) {
        if (error instanceof NeedsLoginError || error instanceof Needs2FAError) {
          logger.log(
            `[useAppDownload] Pre-authentication indicates auth required (${error instanceof NeedsLoginError ? "login" : "2FA"}). Suppressing HUD and pushing form inline.`,
          );

          if (authNavigation) {
            // Keep the global lock while we wait for the inline auth flow to complete
            releaseLock = false;
            if (error instanceof NeedsLoginError) {
              logger.log(`[useAppDownload] Pushing Login form for ${name} (${bundleId})`);
              authNavigation.pushLoginForm?.(async () => {
                try {
                  logger.log(`[useAppDownload] Login callback invoked. Re-checking auth...`);
                  await ensureAuthenticated();
                  authAttemptsByOp.set(operationId, (authAttemptsByOp.get(operationId) ?? 0) + 1);
                  logger.log(`[useAppDownload] Auth OK after login. Resuming download for ${name} (${bundleId})`);
                  await showToast({ style: Toast.Style.Animated, title: "Resuming download..." });
                  await resumeDownload();
                } catch (authError) {
                  const msg = authError instanceof Error ? authError.message : String(authError);
                  const info = analyzeIpatoolError(msg);
                  if (info.isAuthError) {
                    logger.error(`[useAppDownload] Authentication failed after login:`, authError);
                  } else {
                    logger.error(`[useAppDownload] Download retry after login failed:`, authError);
                  }
                }
              });
            } else if (error instanceof Needs2FAError) {
              logger.log(`[useAppDownload] Pushing 2FA form for ${name} (${bundleId})`);
              authNavigation.push2FAForm?.(async () => {
                try {
                  logger.log(`[useAppDownload] 2FA callback invoked. Re-checking auth...`);
                  await ensureAuthenticated();
                  authAttemptsByOp.set(operationId, (authAttemptsByOp.get(operationId) ?? 0) + 1);
                  logger.log(`[useAppDownload] Auth OK after 2FA. Resuming download for ${name} (${bundleId})`);
                  await showToast({ style: Toast.Style.Animated, title: "Resuming download..." });
                  await resumeDownload();
                } catch (authError) {
                  const msg = authError instanceof Error ? authError.message : String(authError);
                  const info = analyzeIpatoolError(msg);
                  if (info.isAuthError) {
                    logger.error(`[useAppDownload] Authentication failed after 2FA:`, authError);
                  } else {
                    logger.error(`[useAppDownload] Download retry after 2FA failed:`, authError);
                  }
                }
              });
            }
          } else {
            // No navigation available; fall back to preferences
            logger.log(
              `[useAppDownload] No authNavigation available. Delegating to handleAuthError with preferences option.`,
            );
            await handleAuthError(error, false, true);
          }

          return undefined;
        }
        // Non-auth errors: rethrow to be handled below
        throw error;
      }

      // Check for an existing IPA in the downloads directory and prompt for
      // overwrite BEFORE showing any progress UI. If the user cancels here, we
      // return early without ever pretending a download started.
      const existing = await checkForExistingDownload(bundleId, name, version);
      if (existing.kind === "skipped") {
        logger.log(`[useAppDownload] User skipped download for ${name} (${bundleId}); existing file kept.`);
        if (showHudMessages) {
          await showToast({
            style: Toast.Style.Success,
            title: "Download Skipped",
            message: `Existing file for ${name} was kept.`,
          });
        }
        return null;
      }

      // Create a toast for progress tracking (similar to video downloader)
      if (showHudMessages) {
        if (authNavigation) {
          logger.log(
            `[useAppDownload] Showing Toast (animated): "Downloading ${name}..." (avoid HUD to keep view open)`,
          );
          progressToast = await showToast({
            style: Toast.Style.Animated,
            title: `Downloading ${name}...`,
            message: "0%",
          });
        } else {
          logger.log(`[useAppDownload] Showing HUD: "Downloading ${name}..."`);
          await showHUD(`Downloading ${name}...`);
        }
      }

      const filePath = await downloadApp(bundleId, name, version, price, 0, undefined, {
        suppressHUD: Boolean(authNavigation),
        onProgress: progressToast
          ? (progress: number) => {
              const percentage = Math.floor(progress * 100);
              if (progressToast) {
                progressToast.message = `${percentage}%`;
              }
              logger.log(`[useAppDownload] Download progress: ${percentage}%`);
            }
          : undefined,
        expectedSizeBytes,
      });

      if (filePath) {
        // Verify file actually exists before showing success
        const fs = await import("fs");
        if (fs.existsSync(filePath)) {
          // Add to download history if app details are available
          if (appDetails) {
            try {
              await addToHistory(appDetails, filePath);
            } catch (error) {
              console.error("Error adding to download history:", error);
            }
          }

          if (showHudMessages && !authNavigation) {
            logger.log(`[useAppDownload] Showing HUD: "Download Complete" for ${name}`);
            await showHUD("Download Complete");
          }

          logger.log(`[useAppDownload] File exists. Success toast for ${name} at ${filePath}`);

          // Update the progress toast if it exists, otherwise create a new success toast
          if (progressToast) {
            progressToast.style = Toast.Style.Success;
            progressToast.title = "Download Complete";
            progressToast.message = name;
            progressToast.primaryAction = {
              title: "Show in Finder",
              shortcut: { modifiers: ["cmd"], key: "o" },
              onAction: async () => {
                await showInFinder(filePath);
              },
            };
            progressToast.secondaryAction = {
              title: "Copy to Clipboard",
              shortcut: { modifiers: ["cmd"], key: "c" },
              onAction: async (toast) => {
                await Clipboard.copy(filePath);
                toast.message = "Path copied to clipboard";
              },
            };
          } else {
            await showToast({
              style: Toast.Style.Success,
              title: "Download Complete",
              message: `${name} saved to ${filePath}`,
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
          }

          return filePath;
        } else {
          // File path returned but file doesn't exist
          if (progressToast) {
            progressToast.style = Toast.Style.Failure;
            progressToast.title = "Download Failed";
            progressToast.message = "File not found at expected path";
          } else if (showHudMessages && !authNavigation) {
            logger.log(`[useAppDownload] Showing HUD: "Download Failed" (file missing) for ${name}`);
            await showHUD("Download Failed");
          }

          await handleDownloadError(
            new Error(`File not found at expected path: ${filePath}`),
            "verify downloaded file",
            "download",
          );
          return undefined;
        }
      } else if (filePath === null) {
        // downloadApp() returns null on a soft non-error stop (e.g. authentication
        // not established by the time the download starts). The existing-file
        // skip path now short-circuits earlier and never reaches downloadApp().
        logger.log(`[useAppDownload] Download did not run for ${name} (${bundleId}); auth or prereq returned null.`);
        if (progressToast) {
          progressToast.style = Toast.Style.Failure;
          progressToast.title = "Download Did Not Start";
          progressToast.message = "Authentication or prerequisites not satisfied.";
        }
        return null;
      } else {
        if (progressToast) {
          progressToast.style = Toast.Style.Failure;
          progressToast.title = "Download Failed";
          progressToast.message = "Could not determine file path";
        } else if (showHudMessages && !authNavigation) {
          logger.log(`[useAppDownload] Showing HUD: "Download Failed" (no file path) for ${name}`);
          await showHUD("Download Failed");
        }

        await handleDownloadError(new Error("Could not determine file path"), "determine file path", "download");
        return undefined;
      }
    } catch (error) {
      // Pre-release / Coming Soon caught from ipatool. Typed error carries the
      // classification across the boundary so we don't have to re-parse a
      // wrapped string. Surface a clean "Not Released Yet" toast and stop —
      // this is an expected state, not a failure of the user's setup.
      if (error instanceof NotYetReleasedError) {
        logger.log(`[useAppDownload] Pre-release caught for ${name} (${bundleId}); surfacing terminal toast.`);
        if (progressToast) {
          progressToast.style = Toast.Style.Failure;
          progressToast.title = "Not Released Yet";
          progressToast.message = error.message;
        } else if (showHudMessages && !authNavigation) {
          await showHUD("Not Released Yet");
        }
        return null;
      }

      if (error instanceof IpatoolSetupError) {
        logger.log(`[useAppDownload] ipatool setup failed for ${name} (${bundleId}): ${error.message}`);
        if (progressToast) {
          progressToast.style = Toast.Style.Failure;
          progressToast.title = error.title;
          progressToast.message = error.message;
        } else if (showHudMessages && !authNavigation) {
          await showHUD(error.title);
        }
        return undefined;
      }

      // Check if this is a specific authentication error that should be handled by the form flow
      if (error instanceof NeedsLoginError || error instanceof Needs2FAError) {
        // Loop breaker: if the user already completed a sign-in during this
        // operation and we STILL get an auth error, re-login isn't fixing it
        // (ipatool#449 — Apple rejects the purchase despite a valid session).
        // Surface a terminal error instead of bouncing to the form again.
        if ((authAttemptsByOp.get(operationId) ?? 0) > 0) {
          logger.error(
            `[useAppDownload] Auth error persists after re-login for ${name} (${bundleId}); not re-prompting.`,
          );
          if (progressToast) {
            progressToast.style = Toast.Style.Failure;
            progressToast.title = "Could Not Download";
            progressToast.message =
              "Apple rejected the request even though you're signed in. This can happen for some apps — please try again later.";
          } else if (showHudMessages && !authNavigation) {
            await showHUD("Could Not Download");
          }
          return undefined;
        }

        // Don't show failure toast for authentication errors
        // The form flow will handle these
        logger.log(
          `[useAppDownload] Caught auth error in main catch (${error instanceof NeedsLoginError ? "login" : "2FA"}). Suppressing HUD and delegating to form flow.`,
        );

        if (authNavigation) {
          // Keep the lock while waiting for inline auth flow
          releaseLock = false;
          // Let the form flow handle authentication
          if (error instanceof NeedsLoginError) {
            logger.log(`[useAppDownload] Pushing Login form (catch) for ${name} (${bundleId})`);
            authNavigation.pushLoginForm?.(async () => {
              // After successful login, resume download
              try {
                logger.log(`[useAppDownload] Login callback (catch) invoked. Re-checking auth...`);
                await ensureAuthenticated();
                authAttemptsByOp.set(operationId, (authAttemptsByOp.get(operationId) ?? 0) + 1);
                logger.log(`[useAppDownload] Auth OK after login (catch). Resuming download for ${name} (${bundleId})`);
                await showToast({ style: Toast.Style.Animated, title: "Resuming download..." });
                await resumeDownload();
              } catch (authError) {
                const msg = authError instanceof Error ? authError.message : String(authError);
                const info = analyzeIpatoolError(msg);
                if (info.isAuthError) {
                  logger.error(`[useAppDownload] Authentication failed after login (catch):`, authError);
                } else {
                  logger.error(`[useAppDownload] Download retry after login failed (catch):`, authError);
                }
              }
            });
          } else if (error instanceof Needs2FAError) {
            logger.log(`[useAppDownload] Pushing 2FA form (catch) for ${name} (${bundleId})`);
            authNavigation.push2FAForm?.(async () => {
              // After successful 2FA, resume download
              try {
                logger.log(`[useAppDownload] 2FA callback (catch) invoked. Re-checking auth...`);
                await ensureAuthenticated();
                authAttemptsByOp.set(operationId, (authAttemptsByOp.get(operationId) ?? 0) + 1);
                logger.log(`[useAppDownload] Auth OK after 2FA (catch). Resuming download for ${name} (${bundleId})`);
                await showToast({ style: Toast.Style.Animated, title: "Resuming download..." });
                await resumeDownload();
              } catch (authError) {
                const msg = authError instanceof Error ? authError.message : String(authError);
                const info = analyzeIpatoolError(msg);
                if (info.isAuthError) {
                  logger.error(`[useAppDownload] Authentication failed after 2FA (catch):`, authError);
                } else {
                  logger.error(`[useAppDownload] Download retry after 2FA failed (catch):`, authError);
                }
              }
            });
          }
        } else {
          // No navigation available, show preferences option
          logger.log(
            `[useAppDownload] No authNavigation available (catch). Delegating to handleAuthError with preferences option.`,
          );
          await handleAuthError(error, false, true);
        }

        return undefined;
      }

      // For other errors, use the existing error analysis
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorAnalysis = analyzeIpatoolError(errorMessage);

      if (showHudMessages) {
        const hudMessage = errorAnalysis.isAuthError
          ? "Authentication Failed"
          : (ERROR_TYPE_TITLES[errorAnalysis.errorType] ?? "Download Failed");

        // Update progress toast if it exists
        if (progressToast) {
          progressToast.style = Toast.Style.Failure;
          progressToast.title = hudMessage;
          progressToast.message = errorAnalysis.userMessage;
        } else if (authNavigation) {
          // Avoid HUD to keep the view open; dedicated error handlers will show toasts
          logger.log(`[useAppDownload] Skipping HUD (view context). Would show: "${hudMessage}" for ${name}`);
        } else {
          logger.log(`[useAppDownload] Showing HUD: "${hudMessage}" for ${name}`);
          await showHUD(hudMessage);
        }
      }

      // For non-specific auth errors, use the existing handler
      if (errorAnalysis.isAuthError && !(error instanceof NeedsLoginError) && !(error instanceof Needs2FAError)) {
        // Handle authentication errors with form redirect if available
        logger.log(
          `[useAppDownload] Non-specific auth error detected. Routing via handleAuthError with potential form navigation.`,
        );
        // Keep the global lock while waiting for inline auth flow via handler
        if (authNavigation) {
          releaseLock = false;
        }
        await handleAuthError(
          new Error(errorAnalysis.userMessage),
          false,
          !authNavigation, // Only show preferences if no navigation available
          undefined,
          authNavigation?.pushLoginForm,
          authNavigation?.push2FAForm,
          async () => {
            // Resume download after successful authentication
            logger.log(`[useAppDownload] Auth success via handler. Resuming download for ${name} (${bundleId})`);
            await showToast({ style: Toast.Style.Animated, title: "Resuming download..." });
            await resumeDownload();
          },
        );
      } else {
        // Handle general download errors with specific user message
        // Pass shouldThrow=false since we're already in error handling and just want to show the toast
        logger.log(
          `[useAppDownload] General download error handled. userMessage="${errorAnalysis.userMessage}" type=${errorAnalysis.errorType}`,
        );
        await handleDownloadError(new Error(errorAnalysis.userMessage), "download app", "download", false);
      }

      return undefined;
    } finally {
      logger.log(`[useAppDownload] Cleaning up global/local download state for ${name} (${bundleId})`);
      // Release the global lock only if this operation owns it and we're not waiting on auth UI
      if (globalDownloadState.activeOpId === operationId && releaseLock) {
        globalDownloadState.isAuthenticating = false;
        globalDownloadState.isDownloading = false;
        globalDownloadState.currentApp = null;
        globalDownloadState.activeOpId = null;
        // Operation is fully finished — forget its auth-attempt count.
        authAttemptsByOp.delete(operationId);
      }

      // Update local state
      setIsLoading(false);
      setCurrentDownload(null);
    }
  };

  return {
    downloadApp: handleDownload,
    isLoading,
    currentDownload,
  };
}
