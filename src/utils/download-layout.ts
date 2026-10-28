/**
 * What `ipatool download` leaves on disk, per platform.
 *
 * Three places need this and they must not drift apart: the progress poller
 * (which files to watch), the integrity check (what a well-formed artifact
 * starts with), and the collision check (what a previous download looks like).
 *
 * Every value here was verified by running ipatool 2.7.0 and reading the bytes,
 * not from its documentation — the macOS pipeline in particular is nothing like
 * the iOS one and is documented nowhere.
 */

/** Platforms this extension can actually download. */
export type DownloadPlatform = "iphone" | "ipad" | "macos";

export interface DownloadLayout {
  /** Suffix of the finished artifact. */
  readonly final: string;
  /**
   * Suffixes ipatool writes while the download is in flight. All of them can
   * exist at once, and the final artifact can exist alongside them.
   */
  readonly temps: readonly string[];
  /** First four bytes of a well-formed artifact. */
  readonly magic: readonly [number, number, number, number];
  /** Human name for the container, for error messages. */
  readonly containerName: string;
  /** True when {@link final} is a ZIP we can walk for `Payload/*.app`. */
  readonly isZip: boolean;
}

/**
 * iOS/iPadOS: bytes land in a sibling `.ipa.tmp` and the real `.ipa` is
 * assembled from it at the end (the repack that injects iTunes artwork), so the
 * final file is LARGER than what was downloaded.
 */
const IPA_LAYOUT: DownloadLayout = {
  final: ".ipa",
  temps: [".ipa.tmp"],
  magic: [0x50, 0x4b, 0x03, 0x04], // PK\x03\x04
  containerName: "ZIP/IPA",
  isZip: true,
};

/**
 * macOS: a two-file pipeline, and a xar archive rather than a ZIP.
 *
 * `<name>.pkg.ipatool-encrypted` grows during the network phase, then
 * `<name>.pkg.ipatool-decrypted` appears ALONGSIDE it, then both collapse into
 * the final `.pkg`. Peak disk is therefore roughly twice the final size — 363 MB
 * observed for a 192 MB app.
 */
const PKG_LAYOUT: DownloadLayout = {
  final: ".pkg",
  temps: [".pkg.ipatool-encrypted", ".pkg.ipatool-decrypted"],
  magic: [0x78, 0x61, 0x72, 0x21], // xar!
  containerName: "xar/PKG",
  isZip: false,
};

const LAYOUTS: Record<DownloadPlatform, DownloadLayout> = {
  iphone: IPA_LAYOUT,
  ipad: IPA_LAYOUT,
  macos: PKG_LAYOUT,
};

export function layoutForPlatform(platform: DownloadPlatform = "iphone"): DownloadLayout {
  return LAYOUTS[platform] ?? IPA_LAYOUT;
}

/**
 * Layout implied by a file already on disk. Used by the integrity check and the
 * rename, which see a path rather than a platform — deriving from the artifact
 * means a future platform cannot silently get the wrong container check.
 */
export function layoutForFile(filePath: string): DownloadLayout {
  return filePath.endsWith(PKG_LAYOUT.final) ? PKG_LAYOUT : IPA_LAYOUT;
}

/**
 * Map the iTunes `kind` field onto a download platform. iTunes reports
 * `mac-software` for Mac App Store titles and `software` for iOS; anything else
 * is treated as iOS, which is what every pre-existing call site assumed.
 */
export function platformForITunesKind(kind?: string): DownloadPlatform {
  return kind === "mac-software" ? "macos" : "iphone";
}
