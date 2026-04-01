import { useNavigation, popToRoot as apiPopToRoot } from "@raycast/api";
import React, { useCallback } from "react";
import { showFailureToast } from "@raycast/utils";
import { logger } from "@chrismessina/raycast-logger";
import { AppleLoginForm } from "../components/forms/AppleLoginForm";
import { AppleTwoFactorForm } from "../components/forms/AppleTwoFactorForm";
import { loginToAppleId, storeAppleId, storePassword, getAppleIdFromStorage } from "../utils/auth";

export interface AuthNavigationHelpers {
  pushLoginForm: (onSuccess?: () => void) => Promise<void>;
  push2FAForm: (onSuccess?: () => void) => void;
  popToRoot: () => void;
}

export function useAuthNavigation(): AuthNavigationHelpers {
  const { push, pop } = useNavigation();

  const push2FAForm = useCallback(
    (onSuccess?: () => void) => {
      push(
        <AppleTwoFactorForm
          onSubmit={async ({ code }) => {
            // For 2FA, we need to re-authenticate with the stored credentials plus the 2FA code
            // The credentials should already be stored from the initial login attempt
            try {
              await loginToAppleId(undefined, undefined, code);
            } catch (error) {
              logger.error("[Auth] 2FA verification failed", error);
              await showFailureToast(error, { title: "Verification failed" });
              // Don't pop — keep form open so user can retry
              return;
            }

            // Call success callback if provided
            if (onSuccess) {
              onSuccess();
            }

            // Pop back to the previous screen
            pop();
          }}
        />,
      );
    },
    [push, pop],
  );

  const pushLoginForm = useCallback(
    async (onSuccess?: () => void) => {
      const storedEmail = await getAppleIdFromStorage();
      push(
        <AppleLoginForm
          initialEmail={storedEmail}
          onSubmit={async ({ email, password }) => {
            try {
              // Always store credentials for a persistent, seamless experience
              await storeAppleId(email);
              await storePassword(password);

              // Attempt login
              await loginToAppleId(email, password);

              // Call success callback if provided
              if (onSuccess) {
                onSuccess();
              }

              // Pop back to the previous screen
              pop();
            } catch (error) {
              // If 2FA is needed, push the 2FA form
              if (error instanceof Error && error.name === "Needs2FAError") {
                // Credentials already stored earlier; proceed to 2FA form
                push2FAForm(onSuccess);
              } else {
                // Show error toast and keep form open for retry
                logger.error("[Auth] Login form submission failed", error);
                await showFailureToast(error, { title: "Login failed" });
              }
            }
          }}
        />,
      );
    },
    [push, pop, push2FAForm],
  );

  const popToRoot = useCallback(() => {
    apiPopToRoot();
  }, [apiPopToRoot]);

  return {
    pushLoginForm,
    push2FAForm,
    popToRoot,
  };
}
