import { execFile } from "child_process";
import { existsSync, realpathSync } from "fs";
import path from "path";
import { promisify } from "util";
import { logger } from "@chrismessina/raycast-logger";
import { getStoredCredentials } from "./auth";
import { getAuthInfo } from "./ipatool-auth";
import { analyzeIpatoolError } from "./ipatool-error-patterns";
import {
  compareVersions,
  createSecureIpatoolProcess,
  executeIpatoolCommand,
  MINIMUM_IPATOOL_VERSION,
  parseIpatoolVersion,
} from "./ipatool-validator";
import { IPATOOL_PATH } from "./paths";

const execFileAsync = promisify(execFile);

export const IPATOOL_RELEASES_URL = "https://github.com/majd/ipatool/releases";
const LATEST_RELEASE_API = "https://api.github.com/repos/majd/ipatool/releases/latest";

/**
 * The app the session probe asks about. Any real App Store app works: the probe
 * only needs Apple to look at the session token, and a "license required"
 * answer proves the token was accepted just as well as a version list does.
 */
const PROBE_BUNDLE_ID = "com.google.chrome.ios";
const PROBE_TIMEOUT_MS = 45_000;
const BREW_UPGRADE_TIMEOUT_MS = 5 * 60_000;

export type CheckState = "ok" | "warn" | "fail" | "unknown";

/** The one action that resolves a check, offered as its Enter default. */
export type Remedy = "update-ipatool" | "open-releases" | "open-preferences" | "sign-in" | "enter-code";

export interface Check {
  id: "ipatool" | "apple-id" | "session" | "password";
  title: string;
  state: CheckState;
  /** One line, shown next to the title. */
  summary: string;
  /** Markdown for the detail pane. */
  detail: string;
  remedy?: Remedy;
}

export interface IpatoolStatus {
  installed?: string;
  latest?: string;
  /** Set only when the configured binary lives in a Homebrew Cellar. */
  brewPath?: string;
}

export interface Diagnosis {
  checks: Check[];
  ipatool: IpatoolStatus;
}

/**
 * Runs every check. Order matters: the session probe only runs once ipatool
 * works and an Apple ID is signed in, because otherwise its failure says
 * nothing the earlier checks have not already said.
 */
export async function diagnose(): Promise<Diagnosis> {
  const [ipatool, latest] = await Promise.all([readInstalledIpatool(), fetchLatestVersion()]);
  const status: IpatoolStatus = { ...ipatool, latest };
  const checks: Check[] = [ipatoolCheck(status, ipatool.error)];

  if (ipatool.error) {
    checks.push(blocked("apple-id", "Apple ID"), blocked("session", "App Store Session"));
  } else {
    const account = await readAccount();
    checks.push(appleIdCheck(account));
    checks.push(account.signedIn ? await sessionCheck() : blocked("session", "App Store Session", "Sign in first."));
  }

  checks.push(await passwordCheck());
  return { checks, ipatool: status };
}

// ── ipatool ──────────────────────────────────────────────────────────────────

/** The installed and latest versions, without the account checks. */
export async function readIpatoolStatus(): Promise<IpatoolStatus> {
  const [{ installed, brewPath }, latest] = await Promise.all([readInstalledIpatool(), fetchLatestVersion()]);
  return { installed, brewPath, latest };
}

async function readInstalledIpatool(): Promise<{ installed?: string; brewPath?: string; error?: string }> {
  if (!existsSync(IPATOOL_PATH)) {
    return { error: `Not found at \`${IPATOOL_PATH}\`.` };
  }

  const result = await executeIpatoolCommand(["--version"], { timeout: 5000, skipOutputValidation: true });
  if (!result.success) {
    return { error: result.error?.message ?? "`ipatool --version` failed.", brewPath: homebrewFor(IPATOOL_PATH) };
  }

  return {
    installed: parseIpatoolVersion(result.stdout || result.stderr || "") ?? undefined,
    brewPath: homebrewFor(IPATOOL_PATH),
  };
}

/**
 * The `brew` that owns this binary, when Homebrew installed it. Resolved from
 * the binary's real path, so a `/opt/homebrew/bin/ipatool` symlink and a
 * `/usr/local` Intel install both find their own prefix, and a release binary
 * the user dropped in `~/bin` is correctly left alone.
 */
function homebrewFor(binary: string): string | undefined {
  try {
    const real = realpathSync(binary);
    const marker = `${path.sep}Cellar${path.sep}ipatool${path.sep}`;
    const index = real.indexOf(marker);
    if (index < 0) return undefined;
    const brew = path.join(real.slice(0, index), "bin", "brew");
    return existsSync(brew) ? brew : undefined;
  } catch {
    return undefined;
  }
}

async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      logger.warn(`[doctor] GitHub answered ${response.status} for the latest ipatool release`);
      return undefined;
    }
    const release = (await response.json()) as { tag_name?: string };
    return release.tag_name?.replace(/^v/, "") || undefined;
  } catch (error) {
    logger.warn("[doctor] Could not fetch the latest ipatool release:", error);
    return undefined;
  }
}

function ipatoolCheck(status: IpatoolStatus, error: string | undefined): Check {
  const { installed, latest, brewPath } = status;
  const updateRemedy: Remedy = brewPath ? "update-ipatool" : "open-releases";
  const lines = [`**Path** \`${IPATOOL_PATH}\``, `**Installed by** ${brewPath ? "Homebrew" : "hand (not Homebrew)"}`];

  if (error) {
    return {
      id: "ipatool",
      title: "ipatool",
      state: "fail",
      summary: "Not working",
      detail: [
        error,
        "",
        ...lines,
        "",
        "Install it with `brew install ipatool`, or set the ipatool Path preference.",
      ].join("\n"),
      remedy: existsSync(IPATOOL_PATH) ? updateRemedy : "open-preferences",
    };
  }

  lines.push(`**Installed** ${installed ? `v${installed}` : "unknown version"}`);
  lines.push(`**Latest release** ${latest ? `v${latest}` : "unknown — GitHub could not be reached"}`);
  lines.push(`**Minimum** v${MINIMUM_IPATOOL_VERSION}`);

  if (installed && compareVersions(installed, MINIMUM_IPATOOL_VERSION) < 0) {
    return {
      id: "ipatool",
      title: "ipatool",
      state: "fail",
      summary: `v${installed} is too old`,
      detail: [`Downloads need ipatool v${MINIMUM_IPATOOL_VERSION} or newer.`, "", ...lines].join("\n"),
      remedy: updateRemedy,
    };
  }

  if (installed && latest && compareVersions(installed, latest) < 0) {
    return {
      id: "ipatool",
      title: "ipatool",
      state: "warn",
      summary: `v${latest} available`,
      detail: [`ipatool v${latest} is out; you have v${installed}.`, "", ...lines].join("\n"),
      remedy: updateRemedy,
    };
  }

  if (!installed) {
    return {
      id: "ipatool",
      title: "ipatool",
      state: "unknown",
      summary: "Version unknown",
      detail: [
        "ipatool runs, but its version could not be read, so neither the minimum nor the latest release could be compared.",
        "",
        ...lines,
      ].join("\n"),
      remedy: updateRemedy,
    };
  }

  return {
    id: "ipatool",
    title: "ipatool",
    state: "ok",
    summary: `v${installed}`,
    detail: [latest ? "Up to date." : "Working. Whether a newer release exists is unknown.", "", ...lines].join("\n"),
  };
}

/**
 * `brew upgrade ipatool`, with Homebrew's usual auto-update so it sees a
 * release from the last few hours. Resolves to brew's output; rejects with it.
 */
export async function upgradeIpatoolWithHomebrew(brewPath: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(brewPath, ["upgrade", "ipatool"], {
    timeout: BREW_UPGRADE_TIMEOUT_MS,
    env: {
      ...process.env,
      // Raycast launches extensions with a minimal PATH; brew's own helpers
      // (git, curl) are found relative to its prefix.
      PATH: `${path.dirname(brewPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOMEBREW_NO_ENV_HINTS: "1",
      HOMEBREW_NO_INSTALL_CLEANUP: "1",
    },
  });
  return `${stdout}\n${stderr}`.trim();
}

// ── Apple ID ─────────────────────────────────────────────────────────────────

interface Account {
  signedIn: boolean;
  name?: string;
  email?: string;
  error?: string;
}

async function readAccount(): Promise<Account> {
  const info = await getAuthInfo();
  if (!info.authenticated) return { signedIn: false, error: info.error };

  try {
    const parsed = JSON.parse(info.raw ?? "") as { name?: string; email?: string };
    return { signedIn: true, name: parsed.name, email: parsed.email };
  } catch {
    return { signedIn: true };
  }
}

function appleIdCheck(account: Account): Check {
  if (!account.signedIn) {
    return {
      id: "apple-id",
      title: "Apple ID",
      state: "fail",
      summary: "Not signed in",
      detail: [
        "ipatool has no Apple ID. Sign in to search your purchases and download apps.",
        ...(account.error ? ["", "ipatool said:", "", "```", account.error.trim(), "```"] : []),
      ].join("\n"),
      remedy: "sign-in",
    };
  }

  const who = [account.name, account.email && `(${account.email})`].filter(Boolean).join(" ");
  return {
    id: "apple-id",
    title: "Apple ID",
    state: "ok",
    summary: account.name ?? "Signed in",
    detail: `Signed in${who ? ` as ${who}` : ""}.`,
  };
}

/**
 * Asks Apple about one app, the way a download does.
 *
 * `ipatool auth info` only reads ipatool's local Keychain item, so it reports
 * "signed in" long after Apple has expired the session token. That expiry
 * surfaces only when a request reaches Apple: ipatool then re-signs in with
 * its stored password, and if Apple wants 2FA it sends a code to the user's
 * devices and ipatool fails with `auth code is required`. `list-versions`
 * takes exactly that path without downloading anything — which also means
 * that in the expired state, running this check is what sends the code.
 */
async function sessionCheck(): Promise<Check> {
  const base = { id: "session" as const, title: "App Store Session" };
  const probe = await runProbe();

  if (probe.ok) {
    return { ...base, state: "ok", summary: "Accepted", detail: "Apple accepted this session. Downloads can start." };
  }

  const analysis = analyzeIpatoolError(probe.error, probe.stderr, "download");

  if (analysis.is2FARequired) {
    return {
      ...base,
      state: "fail",
      summary: "Verification code needed",
      detail: [
        "Apple expired this session and sent a verification code to your devices.",
        "",
        "Enter that code to finish signing in. If it has expired, the code form can send a new one.",
      ].join("\n"),
      remedy: "enter-code",
    };
  }

  if (analysis.errorType === "apple_auth_gate") {
    return { ...base, state: "warn", summary: "Apple refused the request", detail: analysis.userMessage };
  }

  if (analysis.isAuthError) {
    return {
      ...base,
      state: "fail",
      summary: "Sign in again",
      detail: `Apple rejected this session: ${analysis.userMessage}`,
      remedy: "sign-in",
    };
  }

  // A license refusal is an answer about the app, which Apple only gives
  // once it has accepted the token. (An empty `invalid response` is not:
  // ipatool 2.5 gets it for everything, so it proves nothing.)
  if (analysis.isLicenseRequired) {
    return { ...base, state: "ok", summary: "Accepted", detail: "Apple accepted this session. Downloads can start." };
  }

  return {
    ...base,
    state: "unknown",
    summary: "Could not check",
    detail: ["The check did not reach a verdict:", "", "```", probe.error, "```"].join("\n"),
  };
}

type ProbeResult = { ok: true } | { ok: false; error: string; stderr: string };

async function runProbe(): Promise<ProbeResult> {
  const args = ["list-versions", "-b", PROBE_BUNDLE_ID, "--format", "json", "--non-interactive"];

  try {
    // Async on purpose: the validator's `executeIpatoolCommand` is a
    // `spawnSync`, and this call talks to Apple for several seconds — long
    // enough that a blocked event loop would freeze the "Running Doctor…"
    // toast.
    const child = await createSecureIpatoolProcess(args, {
      timeout: PROBE_TIMEOUT_MS,
      allowedCommands: ["list-versions"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    if (code === 0) return { ok: true };
    return { ok: false, error: lastJsonError(stdout) ?? (stdout.trim() || `exit ${code}`), stderr };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), stderr: "" };
  }
}

/** ipatool's `--format json` failure line: `{"level":"error","error":"…"}`. */
function lastJsonError(stdout: string): string | undefined {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { level?: string; error?: string };
      if (parsed.level === "error" && parsed.error) return parsed.error;
    } catch {
      // Not a JSON line.
    }
  }
  return undefined;
}

// ── Saved password ───────────────────────────────────────────────────────────

async function passwordCheck(): Promise<Check> {
  const { email, password } = await getStoredCredentials();
  const base = { id: "password" as const, title: "Saved Password" };

  if (email && password) {
    return {
      ...base,
      state: "ok",
      summary: "In macOS Keychain",
      detail: `The password for ${email} is saved, so when Apple asks you to verify again you only need the code.`,
    };
  }

  return {
    ...base,
    state: "warn",
    summary: "Not saved",
    detail:
      "No password is saved in your Keychain, so each time Apple asks you to verify again you will need to type your password as well as the code. Sign in here once to save it.",
    remedy: "sign-in",
  };
}

// ── Shared ───────────────────────────────────────────────────────────────────

function blocked(id: Check["id"], title: string, reason = "Fix ipatool first."): Check {
  return { id, title, state: "unknown", summary: "Not checked", detail: reason };
}

const STATE_LABEL: Record<CheckState, string> = { ok: "OK", warn: "WARN", fail: "FAIL", unknown: "UNKNOWN" };

export function diagnosticsReport(diagnosis: Diagnosis): string {
  const rows = diagnosis.checks.map((check) => `- [${STATE_LABEL[check.state]}] ${check.title}: ${check.summary}`);
  return ["iOS Apps Doctor", ...rows, "", `ipatool path: ${IPATOOL_PATH}`].join("\n");
}
