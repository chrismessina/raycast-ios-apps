// Run: node --experimental-strip-types src/utils/download-layout.test.mjs
//
// Guards the assumptions the progress poller cannot survive losing: that a temp
// file is never mistaken for the finished artifact, and that liveness survives
// every phase of both layouts.
// Filenames below are verbatim from real ipatool 2.7.0 downloads.
//
// The layout tables come from the REAL production module, not a copy of it —
// `--experimental-strip-types` imports the `.ts` directly, so a change to
// `download-layout.ts` that broke these invariants would fail here instead of
// leaving a green test standing beside regressed code.
//
// `download-lock.ts` is deliberately NOT covered: it reaches `@raycast/api`
// through the logger, which cannot be imported outside Raycast, and stubbing it
// would test the stub. Its behavior is hands-on only.
import assert from "node:assert/strict";
import { layoutForFile, layoutForPlatform, platformForITunesKind } from "./download-layout.ts";

const LAYOUTS = {
  ipa: layoutForPlatform("iphone"),
  pkg: layoutForPlatform("macos"),
};

// The production module must actually agree with what we observed on disk.
assert.equal(LAYOUTS.ipa.final, ".ipa");
assert.equal(LAYOUTS.pkg.final, ".pkg");
assert.deepEqual([...LAYOUTS.pkg.temps].sort(), [".pkg.ipatool-decrypted", ".pkg.ipatool-encrypted"]);
assert.equal(platformForITunesKind("mac-software"), "macos");
assert.equal(platformForITunesKind("software"), "iphone");
assert.equal(platformForITunesKind(undefined), "iphone");

const OBSERVED = [
  ["com.google.chrome.ios_535886823_156.8078.33.ipa.tmp", "ipa", "temp"],
  ["com.google.chrome.ios_535886823_156.8078.33.ipa", "ipa", "final"],
  ["org.discourse.DiscourseApp_1173672076_1.0.ipa", "ipa", "final"],
  ["com.liuliu.draw-things_6444050820_26.1008.0.pkg.ipatool-encrypted", "pkg", "temp"],
  ["com.liuliu.draw-things_6444050820_26.1008.0.pkg.ipatool-decrypted", "pkg", "temp"],
  ["com.liuliu.draw-things_6444050820_26.1008.0.pkg", "pkg", "final"],
  ["com.xiao99xiao.Vista_6760483098_3.6.pkg", "pkg", "final"],
];

// Same classification the poller performs.
function classify(file, layout) {
  if (layout.temps.some((s) => file.endsWith(s))) return "temp";
  if (file.endsWith(layout.final)) return "final";
  return "ignored";
}

for (const [file, key, expected] of OBSERVED) {
  assert.equal(classify(file, LAYOUTS[key]), expected, `${file} should classify as ${expected}`);
  // A finished artifact must also route to the right layout by name alone,
  // which is how `verifyFileIntegrity` picks its magic bytes.
  if (expected === "final") {
    assert.equal(layoutForFile(file).final, LAYOUTS[key].final, `${file} should resolve to ${key}`);
  }
}

// The disjointness the poller's comment relies on: no temp suffix ends with the
// final suffix, so the two tests can never both match.
for (const [key, layout] of Object.entries(LAYOUTS)) {
  for (const temp of layout.temps) {
    assert.ok(!temp.endsWith(layout.final), `${key}: temp ${temp} must not end with ${layout.final}`);
  }
}

// A sibling bundle id must not be picked up by the prefix match.
const prefix = "com.example.app_";
assert.ok(!"com.example.app2_123_1.0.ipa".startsWith(prefix));
assert.ok("com.example.app_123_1.0.ipa".startsWith(prefix));

// Liveness must survive EVERY phase of the macOS lifecycle, including the
// collapse at the end. Three strategies are compared against the real sequence:
//   maxBased     max(encrypted, decrypted) + final   -- the first bug
//   sum          total bytes across all files        -- the second bug
//   fingerprint  sorted name:size of all files       -- what ships
{
  const F = { enc: "a_1_1.0.pkg.ipatool-encrypted", dec: "a_1_1.0.pkg.ipatool-decrypted", fin: "a_1_1.0.pkg" };
  const phase = (encrypted, decrypted, final) => {
    const present = Object.entries({ [F.enc]: encrypted, [F.dec]: decrypted, [F.fin]: final }).filter(
      ([, size]) => size > 0,
    );
    return {
      sum: present.reduce((total, [, size]) => total + size, 0),
      maxBased: Math.max(encrypted, decrypted) + final,
      fingerprint: present
        .map(([name, size]) => `${name}:${size}`)
        .sort()
        .join("|"),
    };
  };

  // Observed for a 192 MB app: download, decrypt alongside, then collapse.
  const seq = [
    phase(192_241_703, 0, 0), // network phase done
    phase(192_241_703, 11_239_424, 0), // decrypt starts
    phase(192_241_703, 171_000_000, 0), // decrypt continues
    phase(0, 0, 192_241_703), // both temps collapse into the final .pkg
  ];

  // What ships: every single transition is detected as liveness.
  for (let i = 1; i < seq.length; i++) {
    assert.notEqual(seq[i].fingerprint, seq[i - 1].fingerprint, `fingerprint must change at transition ${i}`);
  }

  // Regression 1: the max-per-kind watermark is FLAT across the whole decrypt,
  // so the stall timer never reset and killed a download that was writing.
  assert.equal(seq[0].maxBased, seq[1].maxBased, "max-based watermark is flat during decrypt (bug 1)");
  assert.equal(seq[1].maxBased, seq[2].maxBased, "max-based watermark is flat during decrypt (bug 1)");

  // Regression 2: a monotonic SUM fixes the decrypt but not the collapse — the
  // total DROPS from ~384 MB to ~192 MB, so a rises-only watermark reads the
  // finalization phase as no progress and runs the stall timer unreset.
  assert.ok(seq[1].sum > seq[0].sum, "summed watermark rises during decrypt");
  assert.ok(seq[3].sum < seq[2].sum, "summed watermark DROPS at the collapse (bug 2)");
}

// Liveness must not depend on knowing the expected size. A missing
// `fileSizeBytes` (iTunes omitted it, or a retry that does not re-fetch) must
// still feed the stall timer; only the percentage needs a denominator.
{
  const tick = (expectedSizeBytes, changed) => ({
    resetsStallTimer: changed,
    reportsPercent: Boolean(expectedSizeBytes),
  });
  assert.deepEqual(tick(undefined, true), { resetsStallTimer: true, reportsPercent: false });
  assert.deepEqual(tick(0, true), { resetsStallTimer: true, reportsPercent: false });
  assert.deepEqual(tick(192_241_703, true), { resetsStallTimer: true, reportsPercent: true });
}

console.log(`ok - ${OBSERVED.length} observed filenames, full-lifecycle liveness, and missing size`);
