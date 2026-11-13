import { defineConfig } from "eslint/config";
import raycastConfig from "@raycast/eslint-config";

// Failure toasts go through src/utils/toast.ts, which adds Apple's link when
// the error is Apple's sign-in dialog. Importing the kit's toasts directly
// skips that, which is how the link went missing at site after site.
const kitToastBan = {
  importNames: ["showError", "failToast", "onErrorToast"],
  message: "Import showError/failToast from src/utils/toast.ts instead.",
};

export default defineConfig([
  ...raycastConfig,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/utils/toast.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@chrismessina/raycast-kit", ...kitToastBan },
            { name: "@chrismessina/raycast-kit/toast", ...kitToastBan },
          ],
        },
      ],
    },
  },
]);
