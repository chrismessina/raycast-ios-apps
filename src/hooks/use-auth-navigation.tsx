import { logger } from "@chrismessina/raycast-logger";
import React, { useCallback, useRef } from "react";
import { popToRoot as apiPopToRoot, useNavigation } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { AppleLoginForm } from "../components/forms/AppleLoginForm";
import { AppleTwoFactorForm } from "../components/forms/AppleTwoFactorForm";
import { getAppleIdFromStorage, getPasswordFromStorage, loginToAppleId, saveCredentials } from "../utils/auth";

export interface AppleCredentials {
  email: string;
  password: string;
}

export interface AuthNavigationHelpers {
  pushLoginForm: (onSuccess?: () => void) => Promise<void>;
  push2FAForm: (onSuccess?: () => void, credentials?: AppleCredentials) => void;
  popToRoot: () => void;
}

export function useAuthNavigation(): AuthNavigationHelpers {
  const { push, pop } = useNavigation();
  const pushLoginFormRef = useRef<AuthNavigationHelpers["pushLoginForm"] | undefined>(undefined);

  const push2FAForm = useCallback(
    (onSuccess?: () => void, credentials?: AppleCredentials) => {
      void (async () => {
        // ipatool takes the code together with the password. With neither one
        // in hand nor a saved one, ask for the password first; the login form
        // comes back here with it.
        if (!credentials && !(await getPasswordFromStorage())) {
          await pushLoginFormRef.current?.(onSuccess);
          return;
        }
        push(
          <AppleTwoFactorForm
            credentials={credentials}
            onSubmit={async ({ code }) => {
              try {
                await loginToAppleId(credentials?.email, credentials?.password, code);
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
      })();
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
            // Saved only once Apple has accepted the password (signed in, or
            // asked for a code), so a typo never becomes the saved password.
            const save = async () => {
              try {
                await saveCredentials(email, password);
              } catch (error) {
                logger.error("[Auth] Could not save the password to the Keychain", error);
              }
            };
            try {
              await loginToAppleId(email, password);
              await save();

              // Call success callback if provided
              if (onSuccess) {
                onSuccess();
              }

              // Pop back to the previous screen
              pop();
            } catch (error) {
              // If 2FA is needed, push the 2FA form
              if (error instanceof Error && error.name === "Needs2FAError") {
                await save();
                // Hand the code form this password: nothing saves it, so
                // the code form has no other way to get it. The code form
                // pops only itself, which would land back on this login
                // form; pop it too so success returns to where sign-in
                // started.
                push2FAForm(
                  () => {
                    pop();
                    onSuccess?.();
                  },
                  { email, password },
                );
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
  pushLoginFormRef.current = pushLoginForm;

  const popToRoot = useCallback(() => {
    apiPopToRoot();
  }, [apiPopToRoot]);

  return {
    pushLoginForm,
    push2FAForm,
    popToRoot,
  };
}
