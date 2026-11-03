// Run: node --experimental-strip-types src/utils/ipa-job.test.mjs
//
// Guards the pure decisions behind the detached ipatool download: the ticket id,
// the file match that tells two apps apart, how a settled status becomes the
// "run" the attempt loop interprets, which path is the finished artifact, and
// which operation directories the sweeper may delete.
// Filenames and stdout lines are verbatim from real ipatool 2.7.0 runs.
import assert from "node:assert/strict";
import { layoutForPlatform } from "./download-layout.ts";
import {
  buildCleanup,
  buildProgress,
  findFinishedPath,
  ipaJobId,
  positiveBytes,
  shouldSweepOperationDir,
  stallSecondsFrom,
  statusToRun,
} from "./ipa-job.ts";

const IPA = layoutForPlatform("iphone");
const PKG = layoutForPlatform("macos");

// --- id and prefix -----------------------------------------------------------
assert.equal(ipaJobId("com.spotify.client"), "ipa-com.spotify.client");

// --- progress and cleanup specs ------------------------------------------------
assert.deepEqual(buildProgress("/d/.ios-apps-op-x", "com.google.chrome.ios", IPA, 123), {
  kind: "watchFiles",
  dir: "/d/.ios-apps-op-x",
  namePrefix: "com.google.chrome.ios_",
  suffixes: [".ipa.tmp", ".ipa"],
  expectedBytes: 123,
});
assert.equal("expectedBytes" in buildProgress("/d/x", "a.b", IPA, undefined), false, "no size, no key");
assert.deepEqual(buildProgress("/d/x", "a.b", PKG).suffixes, [
  ".pkg.ipatool-encrypted",
  ".pkg.ipatool-decrypted",
  ".pkg",
]);
// iTunes reports fileSizeBytes as a STRING ("289000000"); the package rejects a non-number.
assert.equal(positiveBytes("289000000"), 289000000);
assert.equal(positiveBytes(289000000), 289000000);
assert.equal(positiveBytes("abc"), undefined);
assert.equal(positiveBytes(0), undefined);
assert.equal(positiveBytes(NaN), undefined);
assert.equal(positiveBytes(undefined), undefined);
assert.equal(buildProgress("/d/x", "a.b", IPA, "289000000").expectedBytes, 289000000);
assert.equal(typeof buildProgress("/d/x", "a.b", IPA, "289000000").expectedBytes, "number");
assert.equal("expectedBytes" in buildProgress("/d/x", "a.b", IPA, "abc"), false);
// Cleanup never names the final artifact: on success it shares the prefix.
assert.deepEqual(buildCleanup("/d/x", "a.b", IPA), [{ dir: "/d/x", namePrefix: "a.b_", suffixes: [".ipa.tmp"] }]);
assert.ok(!buildCleanup("/d/x", "a.b", PKG)[0].suffixes.includes(".pkg"));

// --- stall conversion (preference is milliseconds, package wants seconds) ----------
assert.equal(stallSecondsFrom(30000), 30);
assert.equal(stallSecondsFrom(5001), 6);
assert.equal(stallSecondsFrom(1), 1);

// --- settled status -> run ---------------------------------------------------------
const base = { stdout: "", stderr: "" };
assert.deepEqual(statusToRun({ state: "completed", exitCode: 0, ...base }), {
  type: "close",
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  stalled: false,
});
const failed = statusToRun({
  state: "failed",
  exitCode: 1,
  stdout: '{"level":"error","error":"invalid response"}',
  stderr: "x",
  error: { code: "unknown", message: "boom" },
});
assert.equal(failed.type, "close");
assert.equal(failed.code, 1);
assert.equal(failed.stalled, false);
const stalled = statusToRun({
  state: "failed",
  exitSignal: "SIGTERM",
  error: { code: "stalled", message: "No progress" },
  ...base,
});
assert.equal(stalled.type, "close");
assert.equal(stalled.stalled, true);
assert.equal(stalled.code, null);
assert.equal(stalled.signal, "SIGTERM");
// The command never ran: an error, not an exit code.
const never = statusToRun({
  state: "failed",
  error: { code: "validation", message: "Could not start /nope: ENOENT" },
  ...base,
});
assert.equal(never.type, "error");
assert.match(never.error.message, /Could not start/);

// --- finished path: stdout JSON first, status.outputPath second -----------------------
const out = "/d/.ios-apps-op-x/com.google.chrome.ios_535886823_156.8078.33.ipa";
const stdout = `{"level":"info","message":"downloading"}\n{"level":"info","output":"${out}","success":true}\n`;
const exists = (p) => p === out || p === "/d/fallback.ipa";
assert.equal(findFinishedPath({ stdout, finalSuffix: ".ipa", exists }), out);
assert.equal(
  findFinishedPath({ stdout: "", outputPath: "/d/fallback.ipa", finalSuffix: ".ipa", exists }),
  "/d/fallback.ipa",
);
// A parsed path that is a temp file, or does not exist, is not the artifact.
const tmp = `{"output":"${out}.tmp"}`;
assert.equal(findFinishedPath({ stdout: tmp, finalSuffix: ".ipa", exists: () => true }), undefined);
assert.equal(findFinishedPath({ stdout, finalSuffix: ".ipa", exists: () => false }), undefined);
// macOS: the regex-era bug, `.pkg.ipatool-encrypted`, is never accepted as `.pkg`.
const mac = '{"output":"/d/x/a.b_1_2.pkg.ipatool-encrypted"}';
assert.equal(findFinishedPath({ stdout: mac, finalSuffix: ".pkg", exists: () => true }), undefined);

// --- sweeper: never delete a directory a live or unpublished status names ------------------
const DAY = 24 * 60 * 60 * 1000;
const keep = new Set(["/d/.ios-apps-op-live"]);
assert.equal(
  shouldSweepOperationDir({
    name: ".ios-apps-op-old",
    fullPath: "/d/.ios-apps-op-old",
    ageMs: 2 * DAY,
    protectedDirs: keep,
  }),
  true,
);
assert.equal(
  shouldSweepOperationDir({
    name: ".ios-apps-op-live",
    fullPath: "/d/.ios-apps-op-live",
    ageMs: 2 * DAY,
    protectedDirs: keep,
  }),
  false,
);
assert.equal(
  shouldSweepOperationDir({
    name: ".ios-apps-op-new",
    fullPath: "/d/.ios-apps-op-new",
    ageMs: 1000,
    protectedDirs: keep,
  }),
  false,
);
assert.equal(
  shouldSweepOperationDir({
    name: "Spotify 1.0.ipa",
    fullPath: "/d/Spotify 1.0.ipa",
    ageMs: 9 * DAY,
    protectedDirs: keep,
  }),
  false,
);

console.log("ipa-job: all assertions passed");
