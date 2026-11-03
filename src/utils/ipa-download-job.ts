import crypto from "crypto";
import fs from "fs";
import {
  acquireLease,
  clearStatus,
  isCommandStatus,
  isDownloadError,
  isTerminal,
  killDownload,
  listStatuses,
  readStatus,
  startCommand,
  watchStatus,
  type CommandStatus,
  type DownloadTicket,
} from "@chrismessina/raycast-downloader";
import { logger } from "@chrismessina/raycast-logger";
import type { DownloadLayout, DownloadPlatform } from "./download-layout";
import { DownloadInProgressError, removeOperationDirectory } from "./download-lock";
import { DownloadCanceledError } from "./errors";
import { buildCleanup, buildProgress, ipaJobId, stallSecondsFrom, statusToRun, type SettledRun } from "./ipa-job";

/**
 * Everything a command needs to pick a download up after the window that
 * started it is gone. Persisted in the status file, so it holds no credential:
 * ipatool's session lives in the Keychain and never reaches argv or `meta`.
 */
export interface IpaJobMeta {
  kind: "ios-apps-ipa";
  operationDir: string;
  /** The downloads directory the operation directory lives in; the artifact is renamed into it. */
  downloadsDir?: string;
  bundleId: string;
  appName: string;
  appVersion: string;
  price: string;
  platform: DownloadPlatform;
  expectedSizeBytes?: number;
  attempt: number;
  retryDelay: number;
  allowPurchase: boolean;
  allowIntegrityRetry: boolean;
}

/** A settled job, with the logs already read (they are cleared with the status). */
interface SettledJob {
  run: SettledRun;
  /** `status.outputPath`, the fallback when stdout names no usable path. */
  outputPath?: string;
}

function metaOf(status: CommandStatus): IpaJobMeta | undefined {
  const meta = status.meta as Partial<IpaJobMeta> | undefined;
  return meta?.kind === "ios-apps-ipa" && typeof meta.operationDir === "string" && typeof meta.bundleId === "string"
    ? (meta as IpaJobMeta)
    : undefined;
}

/** Every ios-apps job on record: running, or settled and not yet published. */
export function listIpaJobs(): { status: CommandStatus; meta: IpaJobMeta }[] {
  const jobs: { status: CommandStatus; meta: IpaJobMeta }[] = [];
  for (const status of listStatuses()) {
    if (!isCommandStatus(status)) continue;
    const meta = metaOf(status);
    if (meta) jobs.push({ status, meta });
  }
  return jobs;
}

/**
 * Whether a finished job for this app is still waiting to be published (the
 * window that started it closed first). Starting another job under the same id
 * would overwrite its status, the only record of where the artifact sits.
 *
 * A job that ended in failure or cancel has no artifact to protect, so it is
 * cleared here, along with its directory, and does not count.
 */
export function hasUnpublishedJob(bundleId: string): boolean {
  const job = listIpaJobs().find(
    (candidate) => candidate.meta.bundleId === bundleId && isTerminal(candidate.status.state),
  );
  if (!job) return false;
  if (job.status.state === "completed") return true;
  clearStatus(job.status.id);
  removeOperationDirectory(job.meta.operationDir);
  return false;
}

/** A finished download of this app is waiting to be saved; opening a download command saves it. */
export class UnpublishedDownloadError extends Error {
  readonly bundleId: string;

  constructor(bundleId: string) {
    super("An earlier download of this app finished while Raycast was closed and has not been saved yet.");
    this.name = "UnpublishedDownloadError";
    this.bundleId = bundleId;
  }
}

/** Another window finished (or took over and finished) the job this one was waiting on. */
export class JobFinishedElsewhereError extends Error {
  constructor() {
    super("Another Raycast window finished this download.");
    this.name = "JobFinishedElsewhereError";
  }
}

/** Operation directories a job still needs, for the abandoned-directory sweep. */
export function protectedOperationDirs(): Set<string> {
  try {
    return new Set(listIpaJobs().map((job) => job.meta.operationDir));
  } catch (error) {
    logger.warn(`[ipa-job] Could not list jobs for the sweep; protecting nothing:`, error);
    return new Set();
  }
}

export async function startIpaJob(input: {
  argv: [string, ...string[]];
  operationDir: string;
  layout: DownloadLayout;
  maxStallMs: number;
  meta: IpaJobMeta;
}): Promise<DownloadTicket> {
  const { bundleId, appName, expectedSizeBytes } = input.meta;
  try {
    return await startCommand({
      id: ipaJobId(bundleId),
      argv: input.argv,
      filename: appName || bundleId,
      progress: buildProgress(input.operationDir, bundleId, input.layout, expectedSizeBytes),
      cleanupOnFailure: buildCleanup(input.operationDir, bundleId, input.layout),
      // Stall only. `downloadTimeoutSeconds` is documented as a screenshot
      // setting, and as a wall-clock ceiling it killed any large IPA.
      stallSeconds: stallSecondsFrom(input.maxStallMs),
      meta: { ...input.meta },
    });
  } catch (error) {
    if (isDownloadError(error) && error.code === "conflict") throw new DownloadInProgressError(bundleId);
    throw error;
  }
}

function readLog(path: string): string {
  try {
    return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

async function cancelIpaJob(id: string): Promise<void> {
  const status = readStatus(id);
  if (!status || isTerminal(status.state)) return;
  await killDownload({ id, pid: status.pid });
}

const LEASE_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
const STANDBY_POLL_MS = 1_000;
const STANDBY_CLAIM_EVERY = 5;

/**
 * Follows job `id` until it settles. Resolves once, with the logs read and the
 * status cleared. Aborting `signal` stops the job; the stop then arrives as a
 * canceled status and rejects with `DownloadCanceledError`.
 *
 * Exactly one command follows a job: the one holding its lease. Another window
 * that opens meanwhile waits in standby, showing progress, and takes over if
 * the owner's lease lapses (its window closed). It never consumes the status,
 * so it cannot make the owner's finished download look like a vanished one;
 * when the owner finishes it rejects with `JobFinishedElsewhereError`.
 */
export function followIpaJob(
  id: string,
  options: { signal?: AbortSignal; expectedSizeBytes?: number; onProgress?: (progress: number) => void },
): Promise<SettledJob> {
  return new Promise<SettledJob>((resolve, reject) => {
    const ownerId = crypto.randomUUID();
    const startedWatching = Date.now();
    let seen = false;
    let done = false;
    let lastProgress = 0;
    let lastReportedBytes = 0;
    let standbyTicks = 0;
    // Holders, not `let`s: the watcher can settle on its first synchronous tick, before it is assigned.
    const watch: { current?: { stop(): void } } = {};
    const timers: { renew?: NodeJS.Timeout; standby?: NodeJS.Timeout } = {};

    const finish = (action: () => void) => {
      if (done) return;
      done = true;
      watch.current?.stop();
      clearInterval(timers.renew);
      clearInterval(timers.standby);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };

    const onAbort = () => {
      void cancelIpaJob(id).catch((error) => logger.warn(`[ipa-job] Cancel of ${id} failed:`, error));
    };

    const report = (bytes: number, total: number | undefined) => {
      const denominator = options.expectedSizeBytes ?? total;
      // Every 512 KB, as the in-process poller did.
      if (!denominator || bytes <= lastReportedBytes + 512 * 1024) return;
      const progress = Math.min(bytes / denominator, 1);
      if (progress > lastProgress) {
        lastProgress = progress;
        lastReportedBytes = bytes;
        options.onProgress?.(progress);
      }
    };

    const settle = (status: CommandStatus) => {
      const stdout = readLog(status.stdoutPath);
      const stderr = readLog(status.stderrPath);
      clearStatus(id);
      if (status.state === "cancelled") {
        // us-english-ok
        finish(() => reject(new DownloadCanceledError()));
        return;
      }
      finish(() =>
        resolve({
          run: statusToRun({
            state: status.state,
            exitCode: status.exitCode,
            exitSignal: status.exitSignal,
            error: status.error,
            stdout,
            stderr,
          }),
          outputPath: status.outputPath,
        }),
      );
    };

    const abandon = (message: string) =>
      finish(() => resolve({ run: { type: "error", error: new Error(message), stdout: "", stderr: "" } }));

    const tryClaim = (): boolean => {
      try {
        return acquireLease(id, { ownerId, leaseMs: LEASE_MS }) !== null;
      } catch (error) {
        // Fail open, like the old file lock: a lease we cannot write is not worth refusing the download.
        logger.warn(`[ipa-job] Could not take the lease on ${id}; following anyway:`, error);
        return true;
      }
    };

    const follow = () => {
      timers.renew = setInterval(tryClaim, LEASE_RENEW_MS);
      timers.renew.unref?.();
      watch.current = watchStatus(id, {
        onChange: (status) => {
          if (!isCommandStatus(status)) return;
          seen = true;
          report(status.bytesDownloaded, status.totalBytes);
        },
        onSettled: (status) => {
          if (!isCommandStatus(status)) return abandon("The download status was not an ipatool job.");
          // Land on 100%: Apple's size is the installed size, so the poller's last
          // reading is only a fraction of the archive. A zero exit is the signal.
          if (status.state === "completed" && lastProgress < 1) options.onProgress?.(1);
          settle(status);
        },
        onAbandoned: (status) => {
          // The runner died without recording an outcome. Stop whatever it left.
          void killDownload({ id, pid: status.pid }).catch(() => undefined);
          clearStatus(id);
          abandon("The download was interrupted before it finished.");
        },
        onMissing: () => {
          if (seen) return abandon("The download's status disappeared before it finished.");
          // watchStatus gives a runner about 30s to write its first status.
          if (Date.now() - startedWatching > 29_000) abandon("The download never reported a status.");
        },
      });
    };

    const standby = () => {
      logger.log(`[ipa-job] ${id} is followed by another window; waiting`);
      timers.standby = setInterval(() => {
        const status = readStatus(id);
        if (!status) return finish(() => reject(new JobFinishedElsewhereError()));
        if (isCommandStatus(status)) report(status.bytesDownloaded, status.totalBytes);
        // Try the lease now and then: the owner's window may have closed.
        if (++standbyTicks % STANDBY_CLAIM_EVERY === 0 && tryClaim()) {
          clearInterval(timers.standby);
          follow();
        }
      }, STANDBY_POLL_MS);
      timers.standby.unref?.();
    };

    if (tryClaim()) follow();
    else standby();

    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
