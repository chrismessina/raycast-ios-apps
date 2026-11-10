import fs from "fs";
import path from "path";
import { logger } from "@chrismessina/raycast-logger";
import { OPERATION_DIR_PREFIX, shouldSweepOperationDir } from "./ipa-job";

/**
 * Per-attempt operation directories, and the error for "this app is already
 * downloading".
 *
 * Downloads run detached through `@chrismessina/raycast-downloader`, and
 * `startCommand` refuses a second download under the same id
 * (`ipa-<bundleId>`) with `conflict`, so no lock lives here.
 */

export class DownloadInProgressError extends Error {
  // Declared and assigned rather than written as a TypeScript parameter
  // property, so this module stays importable under `node
  // --experimental-strip-types`.
  readonly bundleId: string;

  constructor(bundleId: string) {
    super("This app is already being downloaded.");
    this.name = "DownloadInProgressError";
    this.bundleId = bundleId;
  }
}

/**
 * A private directory for one download attempt, inside the downloads directory
 * so that publishing the result is a same-filesystem rename — atomic, and never
 * a copy.
 *
 * ipatool writes all of its intermediates here (`.ipa.tmp`, the macOS
 * `.pkg.ipatool-encrypted` / `-decrypted` pair), so cleaning up is deleting the
 * directory: no filename-prefix matching that could reach another download's
 * files. The download is detached, so nothing in this process removes the
 * directory when the command closes; whoever publishes or abandons the attempt
 * does. `protectedDirs` names the directories a status still needs.
 */
export function createOperationDirectory(downloadsDir: string, protectedDirs: ReadonlySet<string>): string {
  sweepAbandonedOperationDirectories(downloadsDir, protectedDirs);
  return fs.mkdtempSync(path.join(downloadsDir, OPERATION_DIR_PREFIX));
}

/** Removes an operation directory and everything in it. Never throws. */
export function removeOperationDirectory(operationDir: string): void {
  try {
    fs.rmSync(operationDir, { recursive: true, force: true });
  } catch (error) {
    logger.warn(`[download-lock] Could not remove operation directory ${operationDir}:`, error);
  }
}

function sweepAbandonedOperationDirectories(downloadsDir: string, protectedDirs: ReadonlySet<string>): void {
  try {
    for (const entry of fs.readdirSync(downloadsDir)) {
      const fullPath = path.join(downloadsDir, entry);
      const ageMs = Date.now() - fs.statSync(fullPath).mtimeMs;
      if (shouldSweepOperationDir({ name: entry, fullPath, ageMs, protectedDirs })) {
        logger.log(`[download-lock] Removing abandoned operation directory ${entry}`);
        removeOperationDirectory(fullPath);
      }
    }
  } catch (error) {
    logger.warn(`[download-lock] Could not sweep abandoned operation directories:`, error);
  }
}
