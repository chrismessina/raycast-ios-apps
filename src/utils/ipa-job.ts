/**
 * Pure decisions behind the detached ipatool download.
 *
 * No imports, so `ipa-job.test.mjs` can load it under `node
 * --experimental-strip-types` without `@raycast/api`. The layout arrives as a
 * parameter for the same reason.
 */

interface LayoutLike {
  readonly final: string;
  readonly temps: readonly string[];
}

/** Stable per app, so a second download of the same app is refused as a `conflict`. */
export function ipaJobId(bundleId: string): string {
  return `ipa-${bundleId}`;
}

/** The separator keeps `com.foo.app` from matching `com.foo.app2`'s files. */
function namePrefixFor(bundleId: string): string {
  return `${bundleId}_`;
}

/**
 * A byte count the package will accept, or `undefined`. iTunes reports
 * `fileSizeBytes` as a string, and `startCommand` rejects anything that is not
 * a finite non-negative number, so a raw value would fail the whole download.
 */
export function positiveBytes(value: unknown): number | undefined {
  const bytes = typeof value === "string" ? Number(value) : value;
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

export function buildProgress(operationDir: string, bundleId: string, layout: LayoutLike, expectedBytes?: unknown) {
  const bytes = positiveBytes(expectedBytes);
  return {
    kind: "watchFiles" as const,
    dir: operationDir,
    namePrefix: namePrefixFor(bundleId),
    suffixes: [...layout.temps, layout.final],
    ...(bytes ? { expectedBytes: bytes } : {}),
  };
}

/** Temps only: on success the finished artifact shares the prefix and must survive. */
export function buildCleanup(operationDir: string, bundleId: string, layout: LayoutLike) {
  return [{ dir: operationDir, namePrefix: namePrefixFor(bundleId), suffixes: [...layout.temps] }];
}

/** The stall preference is milliseconds; the package takes whole seconds. */
export function stallSecondsFrom(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

export interface SettledInput {
  state: string;
  exitCode?: number;
  exitSignal?: string;
  error?: { code: string; message: string };
  stdout: string;
  stderr: string;
}

/** The shape `interpretDownload` consumes. */
export type SettledRun =
  | {
      type: "close";
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      stalled: boolean;
    }
  | { type: "error"; error: Error; stdout: string; stderr: string };

/**
 * A settled command status, as the run the attempt loop already knows how to
 * read. A command that never produced an exit code (a missing executable)
 * is an `error`, which the loop treats as a process error, not a failed exit.
 */
export function statusToRun(input: SettledInput): SettledRun {
  const { stdout, stderr } = input;
  if (input.state === "completed") {
    return { type: "close", code: input.exitCode ?? 0, signal: null, stdout, stderr, stalled: false };
  }
  const stalled = input.error?.code === "stalled";
  if (input.exitCode === undefined && input.exitSignal === undefined && !stalled) {
    return { type: "error", error: new Error(input.error?.message ?? "Download failed"), stdout, stderr };
  }
  return {
    type: "close",
    code: input.exitCode ?? null,
    signal: (input.exitSignal as NodeJS.Signals | undefined) ?? null,
    stdout,
    stderr,
    stalled,
  };
}

/**
 * The finished artifact: the `"output"` field of ipatool's JSON line first,
 * `status.outputPath` second. Either must name a finished artifact (not a temp
 * file) that exists.
 */
export function findFinishedPath(input: {
  stdout: string;
  outputPath?: string;
  finalSuffix: string;
  exists: (path: string) => boolean;
}): string | undefined {
  const candidates: string[] = [];
  const lines = input.stdout.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line) as { output?: unknown };
      if (typeof parsed.output === "string" && parsed.output) {
        candidates.push(parsed.output);
        break;
      }
    } catch {
      // Not the JSON line; keep looking.
    }
  }
  if (input.outputPath) candidates.push(input.outputPath);
  return candidates.find((candidate) => candidate.endsWith(input.finalSuffix) && input.exists(candidate));
}

export const OPERATION_DIR_PREFIX = ".ios-apps-op-";
const ABANDONED_OPERATION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * An operation directory is abandoned only when it is old AND no status names
 * it. A finished-but-unpublished download lives there until a command opens
 * and publishes it.
 */
export function shouldSweepOperationDir(input: {
  name: string;
  fullPath: string;
  ageMs: number;
  protectedDirs: ReadonlySet<string>;
}): boolean {
  if (!input.name.startsWith(OPERATION_DIR_PREFIX)) return false;
  if (input.protectedDirs.has(input.fullPath)) return false;
  return input.ageMs > ABANDONED_OPERATION_AGE_MS;
}
