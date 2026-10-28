import { execFile, spawn } from "node:child_process";
import { logger } from "@chrismessina/raycast-logger";
import { LocalStorage } from "@raycast/api";
import {
  AppleAuthGateError,
  AppleEmptyResponseError,
  BuiltInAppError,
  Needs2FAError,
  NeedsLoginError,
  NotYetReleasedError,
} from "./errors";
import { login as ipatoolLogin } from "./ipatool-auth";
import { analyzeIpatoolError } from "./ipatool-error-patterns";
import { executeIpatoolCommand, IpatoolSetupError, validateIpatoolInstallation } from "./ipatool-validator";
import { handleProcessErrorCleanup } from "./temp-file-manager";

// Re-exported so every existing `from "./auth"` importer keeps working.
export {
  AppleAuthGateError,
  AppleEmptyResponseError,
  BuiltInAppError,
  Needs2FAError,
  NeedsLoginError,
  NotYetReleasedError,
};

// The password lives in the macOS login Keychain. @raycast/api has no Keychain
// API, so this goes through /usr/bin/security, which also makes `security`
// the item's trusted app: later reads do not prompt.
const SECURITY = "/usr/bin/security";
const PASSWORD_SERVICE = "ios-apps-apple-password";
/** `security` exit status for "no such item". */
const ITEM_NOT_FOUND = 44;

function runSecurity(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(SECURITY, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

async function readKeychainPassword(account: string): Promise<string | undefined> {
  const { code, stdout, stderr } = await runSecurity([
    "find-generic-password",
    "-s",
    PASSWORD_SERVICE,
    "-a",
    account,
    "-w",
  ]);
  if (code === ITEM_NOT_FOUND) return undefined;
  if (code !== 0) throw new Error(`security find-generic-password exited ${code}: ${stderr.trim()}`);
  const hex = stdout.trim();
  // Written hex-encoded (see writeKeychainPassword); anything else is not ours.
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return undefined;
  return Buffer.from(hex, "hex").toString("utf8");
}

/**
 * Writes the password over stdin, never argv, so it does not show in `ps`.
 * A trailing `-w` makes `security` prompt twice (enter, retype). Detached, so
 * it has no controlling terminal and reads both answers from the pipe.
 *
 * Stored as UTF-8 hex: `security -w` prints any non-ASCII password back as hex
 * and an ASCII one as-is, so reading a raw password back would be ambiguous.
 */
function writeKeychainPassword(account: string, password: string): Promise<void> {
  const hex = Buffer.from(password, "utf8").toString("hex");
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY, ["add-generic-password", "-U", "-s", PASSWORD_SERVICE, "-a", account, "-w"], {
      detached: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    // A locked Keychain can leave `security` waiting on a system dialog.
    const timer = setTimeout(() => child.kill(), 10_000);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`security add-generic-password exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(`${hex}\n${hex}\n`);
  });
}

async function deleteKeychainPassword(account: string): Promise<void> {
  const { code, stderr } = await runSecurity(["delete-generic-password", "-s", PASSWORD_SERVICE, "-a", account]);
  if (code !== 0 && code !== ITEM_NOT_FOUND) {
    throw new Error(`security delete-generic-password exited ${code}: ${stderr.trim()}`);
  }
}

/**
 * Securely retrieve Apple ID from local storage
 */
export async function getAppleIdFromStorage(): Promise<string | undefined> {
  return await LocalStorage.getItem<string>("appleId");
}

/**
 * Securely retrieve password from storage
 */
export async function getPasswordFromStorage(): Promise<string | undefined> {
  try {
    const appleId = await LocalStorage.getItem<string>("appleId");
    if (!appleId) {
      return undefined;
    }
    return await readKeychainPassword(appleId);
  } catch (e) {
    logger.error("Failed to read password from secure storage", { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

/**
 * Saves the Apple ID and its password together, keyed by `email` itself rather
 * than whatever `appleId` holds by the time the write runs. Signing in as a
 * different Apple ID deletes the previous one's password, which Logout could
 * otherwise never find again.
 */
export async function saveCredentials(email: string, password: string): Promise<void> {
  const previous = await LocalStorage.getItem<string>("appleId");
  await LocalStorage.setItem("appleId", email);
  if (previous && previous !== email) {
    try {
      await deleteKeychainPassword(previous);
    } catch (error) {
      logger.error("Failed to delete the previous Apple ID's password", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await writeKeychainPassword(email, password);
}

/**
 * Convenience: return stored credentials if present
 */
export async function getStoredCredentials(): Promise<{ email?: string; password?: string }> {
  const email = await getAppleIdFromStorage();
  if (!email) return {};
  try {
    return { email, password: await readKeychainPassword(email) };
  } catch (e) {
    logger.error("Failed to read password from secure storage", { error: e instanceof Error ? e.message : String(e) });
    return { email };
  }
}

/**
 * A confirmed-authenticated result, cached briefly.
 *
 * A single download calls `ensureAuthenticated()` twice — once as the hook's
 * pre-flight, once inside `downloadApp` — and each call spawned `--version`
 * plus `auth info`. The TTL is deliberately short: the ipatool session lives in
 * the system Keychain and can be revoked from outside this extension, so this
 * collapses the duplicate calls of one user action without pretending to know
 * the session state minutes later. Cleared by {@link invalidateAuthentication}.
 */
let authConfirmedAt = 0;
/**
 * Bumped on every invalidation. An `auth info` already in flight when the
 * session is cleared must not write its now-meaningless success back — ipatool
 * calls are not abortable, so the old check WILL finish and try.
 */
let authGeneration = 0;
let authInFlight: Promise<boolean> | null = null;
const AUTH_CACHE_TTL_MS = 30_000;

/** Forget the cached auth result. Call whenever the session may have changed. */
export function clearAuthenticationCache(): void {
  authGeneration += 1;
  authConfirmedAt = 0;
  authInFlight = null;
}

/**
 * Clear stored credentials from storage
 */
export async function clearStoredCredentials(): Promise<void> {
  // Invalidate FIRST, before any awaited Keychain/storage work: a check that
  // is already in flight must be fenced off before this function yields.
  // Every credential-clearing path routes through here — logout, auth-error
  // invalidation, re-login — so no caller can forget to do it.
  clearAuthenticationCache();

  // Capture appleId first for keychain deletion
  const appleId = await LocalStorage.getItem<string>("appleId");
  // Best-effort cleanup of secure storage for current account
  try {
    if (appleId) {
      await deleteKeychainPassword(appleId);
    }
  } catch (e) {
    logger.error("Failed to delete password from secure storage", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  // Remove identifiers
  await LocalStorage.removeItem("appleId");
}

/**
 * Invalidate authentication by clearing stored credentials
 * This should be called when authentication errors occur to force re-authentication
 */
export async function invalidateAuthentication(): Promise<void> {
  logger.log("Invalidating authentication - clearing stored credentials");
  await clearStoredCredentials();
}

/**
 * Secure wrapper for executing ipatool commands with error handling
 */
async function executeSecureIpatoolCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await executeIpatoolCommand(args, {
    timeout: 30000, // 30 second timeout for auth commands
    allowedCommands: ["auth"],
  });

  // Special handling for auth info command - it returns exit code 1 when not authenticated
  const isAuthInfoCommand = args[0] === "auth" && args[1] === "info";

  if (!result.success && !isAuthInfoCommand) {
    const error = result.error || new Error("Unknown execution error");
    handleProcessErrorCleanup(error, "executeSecureIpatoolCommand");
    throw error;
  }

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

/**
 * Logs in to Apple ID using ipatool and user preferences.
 * Delegates to ipatool-auth.ts:login() which uses async spawn with real-time
 * 2FA detection — correctly handles the case where ipatool exits 0 but 2FA is needed.
 * @param appleId Optional Apple ID email
 * @param password Optional password
 * @param twoFactorCode Optional 2FA code for two-factor authentication
 */
export async function loginToAppleId(appleId?: string, password?: string, twoFactorCode?: string): Promise<void> {
  const done = logger.time("loginToAppleId");

  // Step 1: Resolve credentials
  logger.step(1, "Resolving credentials");
  const stored = appleId && password ? {} : await getStoredCredentials();
  const email = appleId || stored.email;
  const pass = password || (email === stored.email ? stored.password : undefined);

  if (!email || !pass) {
    done({ result: "missing_credentials" });
    throw new NeedsLoginError("Apple ID and password are required for authentication");
  }

  // Step 2: Call ipatool login via async spawn
  logger.step(2, "Calling ipatool login");
  try {
    const result = await ipatoolLogin({ email, password: pass, code: twoFactorCode });

    // Step 3: Map result to error types
    logger.step(3, "Login result", { success: result.success, needs2FA: result.needs2FA });

    if (result.needs2FA) {
      done({ result: "needs_2fa" });
      throw new Needs2FAError("Two-factor authentication code required");
    }

    if (!result.success) {
      done({ result: "failed" });
      throw new NeedsLoginError(result.message || "Authentication failed");
    }

    done({ result: "success" });
    logger.info("[Auth] Successfully authenticated with Apple ID");
  } catch (error) {
    // Re-throw our own typed errors as-is. AppleAuthGateError included: the
    // re-analysis below sees only the friendly text and would demote it to
    // generic, losing the "signing in again won't help" routing.
    if (error instanceof NeedsLoginError || error instanceof Needs2FAError || error instanceof AppleAuthGateError) {
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Auth] Login failed", { error: errorMessage });

    // Use error analysis for classification
    const errorAnalysis = analyzeIpatoolError(errorMessage, undefined, "auth");

    if (errorAnalysis.is2FARequired) {
      done({ result: "needs_2fa" });
      throw new Needs2FAError("Two-factor authentication code required");
    }

    done({ result: "error" });
    throw new Error(errorAnalysis.userMessage);
  }
}

/**
 * Ensures the user is authenticated with Apple ID
 * @param options Optional authentication credentials
 */
export async function ensureAuthenticated(options?: {
  email?: string;
  password?: string;
  code?: string;
}): Promise<boolean> {
  // Anything carrying credentials is an explicit (re)login — never serve those
  // from cache, and drop whatever we had.
  // Presence, not truthiness: `{ code: "" }` is still an explicit request and
  // must reach the real flow to be rejected, not be answered from cache.
  const isExplicitLogin = options !== undefined && ("email" in options || "password" in options || "code" in options);
  if (isExplicitLogin) {
    clearAuthenticationCache();
    return ensureAuthenticatedUncached(options);
  }

  if (Date.now() - authConfirmedAt < AUTH_CACHE_TTL_MS) {
    logger.log("[Auth] Reusing the authentication check from this operation");
    return true;
  }
  if (authInFlight) {
    return authInFlight;
  }

  const generation = authGeneration;
  const attempt: Promise<boolean> = ensureAuthenticatedUncached(options)
    .then((authenticated) => {
      // Only the current generation may write. If the session was cleared while
      // this was in flight, its result describes a session that no longer
      // exists.
      if (generation === authGeneration) {
        authConfirmedAt = authenticated ? Date.now() : 0;
      } else {
        logger.log("[Auth] Discarding an auth result from before the session was cleared");
      }
      return authenticated;
    })
    .catch((error) => {
      // A throw is a failure too. Without this the previous SUCCESSFUL
      // timestamp survives, so a genuine auth failure could be masked by the
      // cache for the rest of the TTL.
      if (generation === authGeneration) {
        authConfirmedAt = 0;
      }
      throw error;
    })
    .finally(() => {
      // Clear the slot only if it is still ours — an unconditional null here
      // would wipe a newer attempt started after an invalidation.
      if (authInFlight === attempt) {
        authInFlight = null;
      }
    });

  authInFlight = attempt;
  return attempt;
}

async function ensureAuthenticatedUncached(options?: {
  email?: string;
  password?: string;
  code?: string;
}): Promise<boolean> {
  // First validate that ipatool is installed and accessible
  const isIpatoolValid = await validateIpatoolInstallation({ throwOnFailure: true });
  if (!isIpatoolValid) {
    return false;
  }

  try {
    // Check if we're already authenticated (skip if we have a 2FA code to submit)
    if (!options?.code) {
      const { stdout, stderr } = await executeSecureIpatoolCommand([
        "auth",
        "info",
        "--format",
        "json",
        "--non-interactive",
      ]);

      // Log the output for debugging
      logger.log("[auth info] stdout:", stdout);
      logger.log("[auth info] stderr:", stderr);

      try {
        // Try to parse as JSON
        const status = JSON.parse(stdout);

        // Check for success field and authenticated status
        if (status.success === false && status.error) {
          // Check if it's a keyring error (not authenticated)
          if (
            status.error.includes("failed to get account") ||
            status.error.includes("keyring") ||
            status.error.includes("The specified item could not be found")
          ) {
            logger.log("[auth info] User is not authenticated (keyring error)");
            // Continue to login flow
          } else {
            // Other error - throw it
            throw new Error(status.error);
          }
        } else if (status.authenticated === true || status.success === true) {
          return true; // Already authenticated
        }
      } catch {
        // If we can't parse as JSON, check the output
        if (stdout.trim() === "" && stderr.includes("Not authenticated")) {
          // Not authenticated - this is expected
          logger.log("[auth info] User is not authenticated");
        } else if (!stdout.includes("Not authenticated") && !stderr.includes("Not authenticated")) {
          // If there's no clear "Not authenticated" message, assume authenticated
          return true;
        }
      }
    }

    // Check if we need to throw specific errors for missing credentials
    const storedEmail = await getAppleIdFromStorage();
    const storedPassword = await getPasswordFromStorage();

    // If no credentials provided and no stored credentials, throw NeedsLoginError
    if (!options?.email && !storedEmail) {
      throw new NeedsLoginError("Please provide Apple ID credentials");
    }

    if (!options?.password && !storedPassword) {
      throw new NeedsLoginError("Please provide Apple ID password");
    }

    // Attempt to login with provided or stored credentials
    await loginToAppleId(options?.email, options?.password, options?.code);

    // CRITICAL: Verify authentication actually took after login to avoid keyring mismatch
    try {
      const { stdout: verifyOut, stderr: verifyErr } = await executeSecureIpatoolCommand([
        "auth",
        "info",
        "--format",
        "json",
        "--non-interactive",
      ]);
      logger.log("[auth info] post-login stdout:", verifyOut);
      logger.log("[auth info] post-login stderr:", verifyErr);
      if (verifyOut.trim()) {
        const status = JSON.parse(verifyOut);
        if (status.authenticated === true || status.success === true) {
          return true;
        }
        // If ipatool explicitly reports a keyring/account error, surface a login-needed error
        if (
          typeof status.error === "string" &&
          (status.error.includes("failed to get account") ||
            status.error.includes("keyring") ||
            status.error.includes("The specified item could not be found"))
        ) {
          throw new NeedsLoginError(
            "Keychain item not found for ipatool after login. Please re-authenticate and allow Keychain access.",
          );
        }
      }
      // As a fallback, treat empty/non-JSON successful responses as authenticated
      if (!verifyErr.toLowerCase().includes("not authenticated")) {
        return true;
      }
      // Explicit not authenticated in stderr
      throw new NeedsLoginError("Authentication did not persist. Please try logging in again.");
    } catch (e) {
      // If verification failed because we raised a login-needed error, rethrow it
      if (e instanceof NeedsLoginError) {
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn("[auth info] post-login verification parse failed", msg);
      // Do NOT assume authenticated on parse errors; fall through to generic login-needed guidance
      throw new NeedsLoginError("Unable to verify authentication. Please try logging in again.");
    }

    // If we reached here, we are still not authenticated
    throw new NeedsLoginError("Authentication did not persist. Please try logging in again.");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error("Authentication check failed", { error: errorMessage });

    // Re-throw our typed errors as-is, for the same reason as in loginToAppleId.
    if (
      error instanceof NeedsLoginError ||
      error instanceof Needs2FAError ||
      error instanceof IpatoolSetupError ||
      error instanceof AppleAuthGateError
    ) {
      throw error;
    }

    // Use precise ipatool error analysis with auth context
    const errorAnalysis = analyzeIpatoolError(errorMessage, undefined, "auth");

    // Check if it's an authentication error that needs login
    if (errorAnalysis.isAuthError && !options?.email && !options?.password) {
      // Throw NeedsLoginError to trigger the login form
      throw new NeedsLoginError(errorAnalysis.userMessage);
    }

    // For other errors, throw with user-friendly message
    throw new Error(errorAnalysis.userMessage);
  }
}
