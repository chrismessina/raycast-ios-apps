import crypto from "crypto";
import fs from "fs";
import path from "path";
import { logger } from "@chrismessina/raycast-logger";
import type { DownloadPlatform } from "./download-layout";

/**
 * "This app is already downloading" — a courtesy, not a correctness mechanism.
 *
 * Every Raycast command runs in its own JS context, and they all share one
 * downloads directory. What used to make two downloads of one app destructive
 * was that both wrote into that shared directory and swept it by bundle prefix,
 * so each deleted the other's live intermediates. That is now impossible by
 * construction: every attempt writes into its own private operation directory
 * (see `createOperationDirectory`) and only the finished artifact is renamed
 * into the downloads directory.
 *
 * So this lock no longer has to be right in every interleaving; it only has to
 * stop the common case — Search and the AI tool both told to fetch the same app
 * — from doing the work twice. That is why it is deliberately dumb, and why
 * every way it can fail is a way that FAILS OPEN:
 *
 *   - a record that is missing, unreadable, from a dead pid, or not
 *     heartbeated within `LEASE_MS` is simply overwritten, with no reclaim
 *     protocol;
 *   - two processes that overwrite a stale record at the same instant both
 *     proceed, which now costs a duplicate download and nothing else;
 *   - a record that cannot be written at all lets the download run unlocked.
 *
 * The previous version tried to be a real mutex (exclusive create, stale-lock
 * reclamation) and was wrong in single-process use: it logged that it was
 * reclaiming a dead owner's lock and then failed to create over the very file it
 * had just declared dead, so one crashed download blocked that app for an hour.
 * Being a real mutex correctly needs an atomic reclaim that `fs` cannot express
 * portably, and nothing here needs one any more.
 *
 * Scope is the bundle, not bundle+platform: a simultaneous iOS and macOS
 * download of one app would duplicate the same work.
 */

const LOCK_PREFIX = ".ios-apps-download-";

/**
 * Liveness is a heartbeat, not the pid. Every command shares one pid — the
 * Raycast Backend — so a command closed mid-download (its context torn down,
 * its `finally` never run) left a record whose pid was still alive, and the app
 * stayed "already downloading" until a timeout-sized age bound ran out.
 */
const HEARTBEAT_MS = 5_000;
const LEASE_MS = 30_000;

interface LockRecord {
  readonly pid: number;
  /** Distinguishes two sequential holds by the same process. */
  readonly token: string;
  readonly bundleId: string;
  readonly platform: DownloadPlatform;
  /** Rewritten every `HEARTBEAT_MS` while the download runs. */
  readonly refreshedAt: number;
}

export interface DownloadLock {
  /** Idempotent. Stops the heartbeat; only removes the record if it is still ours. */
  release(): void;
}

export class DownloadInProgressError extends Error {
  // Declared and assigned rather than written as a TypeScript parameter
  // property, so this module stays importable under `node
  // --experimental-strip-types`.
  readonly bundleId: string;

  constructor(bundleId: string) {
    super("This app is already being downloaded in another Raycast command.");
    this.name = "DownloadInProgressError";
    this.bundleId = bundleId;
  }
}

function lockPathFor(downloadsDir: string, bundleId: string): string {
  // Hashed rather than embedded: a long bundle id can fit a 255-byte filename
  // limit as a download name and still overflow it with the lock prefix added.
  const digest = crypto.createHash("sha256").update(bundleId).digest("hex").slice(0, 32);
  return path.join(downloadsDir, `${LOCK_PREFIX}${digest}.json`);
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks existence and permission without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readRecord(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    if (typeof parsed?.pid !== "number" || typeof parsed?.token !== "string") return null;
    if (typeof parsed?.refreshedAt !== "number") return null;
    return parsed as LockRecord;
  } catch {
    // Missing, truncated, or from the previous lock format: nobody to honor.
    return null;
  }
}

function writeRecord(lockPath: string, record: LockRecord): void {
  fs.writeFileSync(lockPath, JSON.stringify(record));
}

/**
 * Claims `bundleId`'s download until `release()`, heartbeating meanwhile.
 *
 * @throws DownloadInProgressError when a live process holds a fresh record.
 */
export function acquireDownloadLock(downloadsDir: string, bundleId: string, platform: DownloadPlatform): DownloadLock {
  const lockPath = lockPathFor(downloadsDir, bundleId);
  const existing = readRecord(lockPath);

  if (existing) {
    const age = Date.now() - existing.refreshedAt;
    if (isProcessAlive(existing.pid) && age <= LEASE_MS) {
      logger.log(`[download-lock] ${bundleId} is held by pid ${existing.pid} (${Math.round(age / 1000)}s)`);
      throw new DownloadInProgressError(bundleId);
    }
    logger.log(`[download-lock] Replacing abandoned lock for ${bundleId} (pid ${existing.pid})`);
  }

  const token = crypto.randomUUID();
  const recordNow = (): LockRecord => ({ pid: process.pid, token, bundleId, platform, refreshedAt: Date.now() });

  try {
    writeRecord(lockPath, recordNow());
  } catch (error) {
    // Fail open: the operation directory already keeps a duplicate download
    // from damaging anything, so a lock we cannot write is not worth a refusal.
    logger.error(`[download-lock] Could not write lock for ${bundleId}, continuing unlocked:`, error);
    return { release: () => {} };
  }

  logger.log(`[download-lock] Acquired ${bundleId}`);

  const isStillOurs = () => readRecord(lockPath)?.token === token;
  let released = false;

  // Dies with the command's context, which is exactly when the record should
  // stop looking alive. Unref'd so it never keeps a process up on its own.
  const heartbeat = setInterval(() => {
    if (released || !isStillOurs()) return;
    try {
      writeRecord(lockPath, recordNow());
    } catch (error) {
      logger.warn(`[download-lock] Could not refresh lock for ${bundleId}:`, error);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      try {
        if (!isStillOurs()) return;
        fs.unlinkSync(lockPath);
        logger.log(`[download-lock] Released ${bundleId}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          logger.error(`[download-lock] Failed to release ${bundleId}:`, error);
        }
      }
    },
  };
}

/** Lock files must never be mistaken for downloads by a directory scan. */
export function isLockFile(fileName: string): boolean {
  return fileName.startsWith(LOCK_PREFIX);
}

const OPERATION_DIR_PREFIX = ".ios-apps-op-";

/**
 * Operation directories older than this are leftovers from a process that died
 * mid-download (Raycast force-quit, a SIGKILL). No attempt can live this long,
 * because the hard download timeout kills it first.
 */
const ABANDONED_OPERATION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A private directory for one download attempt, inside the downloads directory
 * so that publishing the result is a same-filesystem rename — atomic, and never
 * a copy.
 *
 * ipatool writes all of its intermediates here (`.ipa.tmp`, the macOS
 * `.pkg.ipatool-encrypted` / `-decrypted` pair), so cleaning up is deleting the
 * directory: no filename-prefix matching that could reach another download's
 * files, and a writer that outlives us (an ipatool orphaned by a force-quit
 * Raycast) can only ever write into a directory nobody else uses.
 */
export function createOperationDirectory(downloadsDir: string): string {
  sweepAbandonedOperationDirectories(downloadsDir);
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

function sweepAbandonedOperationDirectories(downloadsDir: string): void {
  try {
    for (const entry of fs.readdirSync(downloadsDir)) {
      if (!entry.startsWith(OPERATION_DIR_PREFIX)) continue;
      const fullPath = path.join(downloadsDir, entry);
      if (Date.now() - fs.statSync(fullPath).mtimeMs > ABANDONED_OPERATION_AGE_MS) {
        logger.log(`[download-lock] Removing abandoned operation directory ${entry}`);
        removeOperationDirectory(fullPath);
      }
    }
  } catch (error) {
    logger.warn(`[download-lock] Could not sweep abandoned operation directories:`, error);
  }
}
