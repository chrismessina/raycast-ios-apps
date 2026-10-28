import fs from "fs";
import { logger } from "@chrismessina/raycast-logger";
import { getConfig } from "../config";

/**
 * Global array to track all temporary files created during the application lifecycle
 */
let tempFiles: string[] = [];
let exitHandlerRegistered = false;

/**
 * Registers a temporary file or directory for last-chance cleanup on exit
 * @param filePath - The path to track. Downloads register their whole operation
 *   directory, which is removed recursively.
 */
export function registerTempFile(filePath: string): void {
  if (!tempFiles.includes(filePath)) {
    tempFiles.push(filePath);
    logger.log(`[TempFileManager] Registered temp file: ${filePath}`);
  }

  // Register the exit handler on first use
  if (!exitHandlerRegistered) {
    registerExitHandler();
    exitHandlerRegistered = true;
  }
}

/**
 * Unregisters a temporary file from tracking (useful when file is no longer temporary)
 * @param filePath - The path to the temporary file to unregister
 */
export function unregisterTempFile(filePath: string): void {
  const index = tempFiles.indexOf(filePath);
  if (index > -1) {
    tempFiles.splice(index, 1);
    logger.log(`[TempFileManager] Unregistered temp file: ${filePath}`);
  }
}

/**
 * Cleans up all registered temporary files
 * Swallows fs errors but logs them via logger.error
 */
export function cleanupTempFiles(): void {
  logger.log(`[TempFileManager] Starting cleanup of ${tempFiles.length} temp files`);

  for (const filePath of tempFiles) {
    try {
      // Check if file exists before attempting to delete. `rmSync` rather than
      // `unlinkSync`: a download registers its operation DIRECTORY.
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { recursive: true, force: true });
        logger.log(`[TempFileManager] Successfully deleted temp file: ${filePath}`);
      } else {
        logger.log(`[TempFileManager] Temp file already deleted or does not exist: ${filePath}`);
      }
    } catch (error) {
      // Swallow fs errors but log them
      logger.error(`[TempFileManager] Error deleting temp file ${filePath}:`, error);
    }
  }

  // Clear the array after cleanup attempt
  tempFiles = [];
  logger.log(`[TempFileManager] Temp file cleanup completed`);
}

/**
 * Logs a process error. It no longer deletes anything.
 *
 * It used to run `cleanupTempFiles()`, which deletes EVERY registered path in
 * this process — so an unrelated ipatool command failing (an auth command, via
 * `executeSecureIpatoolCommand`) deleted the operation directory of a download
 * still running in the same command. Each download now removes its own
 * operation directory when its attempt ends; process-wide cleanup is only for
 * process exit.
 * @param error - The error that occurred
 * @param context - Context information about where the error occurred
 */
export function handleProcessErrorCleanup(error: Error, context: string): void {
  logger.error(`[TempFileManager] Process error in ${context}:`, error);
}

/**
 * Registers process exit handlers for last-chance cleanup
 * Respects the tempCleanupOnExit configuration flag
 */
function registerExitHandler(): void {
  const performExitCleanup = () => {
    const config = getConfig();

    if (config.tempCleanupOnExit && tempFiles.length > 0) {
      logger.log(`[TempFileManager] Process exit detected, performing last-chance cleanup (${tempFiles.length} files)`);
      cleanupTempFiles();
    } else if (!config.tempCleanupOnExit) {
      logger.log(`[TempFileManager] Process exit detected, but tempCleanupOnExit is disabled`);
    }
  };

  // Register exit handler
  process.on("exit", (code) => {
    logger.log(`[TempFileManager] Process exiting with code ${code}`);
    performExitCleanup();
  });

  // Handle other termination signals
  process.on("SIGINT", () => {
    logger.log(`[TempFileManager] Received SIGINT`);
    performExitCleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    logger.log(`[TempFileManager] Received SIGTERM`);
    performExitCleanup();
    process.exit(0);
  });

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    logger.error(`[TempFileManager] Uncaught exception:`, error);
    performExitCleanup();
    process.exit(1);
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    logger.error(`[TempFileManager] Unhandled rejection at:`, promise, "reason:", reason);
    performExitCleanup();
    process.exit(1);
  });

  logger.log(`[TempFileManager] Exit handlers registered`);
}

/**
 * Gets the current list of tracked temporary files (for debugging)
 */
export function getTrackedTempFiles(): readonly string[] {
  return [...tempFiles];
}

/**
 * Clears all tracked temporary files without deleting them (for testing)
 */
export function clearTempFileTracking(): void {
  tempFiles = [];
  logger.log(`[TempFileManager] Cleared temp file tracking`);
}
