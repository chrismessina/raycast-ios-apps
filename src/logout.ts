import { showHUD } from "@raycast/api";
import { revoke, getAuthInfo } from "./utils/ipatool-auth";
import { validateIpatoolInstallation } from "./utils/ipatool-validator";
import { clearStoredCredentials } from "./utils/auth";
import { logger } from "@chrismessina/raycast-logger";

export default async function Command() {
  try {
    logger.log("[Logout] Starting logout flow");
    const ipatoolAvailable = await validateIpatoolInstallation();

    // Check if already signed out before attempting revoke
    if (ipatoolAvailable) {
      try {
        const info = await getAuthInfo();
        if (!info.authenticated) {
          logger.info("[Logout] Already signed out, clearing local credentials");
          await clearStoredCredentials();
          await showHUD("Already signed out");
          return;
        }
        logger.log("[Logout] Currently authenticated, proceeding with revoke");
      } catch (e) {
        // If we can't check, proceed with revoke attempt
        logger.warn("[Logout] Could not check auth status, proceeding with revoke", e);
      }

      try {
        await revoke();
        logger.info("[Logout] ipatool auth revoked successfully");
      } catch (e) {
        // Even if revoke fails, proceed to clear local credentials for safety
        const msg = e instanceof Error ? e.message : String(e);
        logger.error("[Logout] Failed to revoke ipatool auth", { error: msg });
      }
    } else {
      logger.warn("[Logout] ipatool not available, skipping revoke");
    }

    logger.log("[Logout] Clearing stored credentials");
    await clearStoredCredentials();

    // Verify auth status post-logout when ipatool is available
    if (ipatoolAvailable) {
      try {
        const info = await getAuthInfo();
        if (info.authenticated) {
          logger.warn("[Logout] Auth still active after revoke");
          await showHUD("⚠️ Signed out locally — ipatool session may still be active");
          return;
        }
        logger.log("[Logout] Verified: no longer authenticated");
      } catch (e) {
        logger.log("[Logout] Auth verification after logout failed", e);
      }
    }

    logger.info("[Logout] Signed out successfully");
    await showHUD("✅ Signed out successfully");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[Logout] Logout failed", { error: message });
    await showHUD("❌ Logout failed");
  }
}
