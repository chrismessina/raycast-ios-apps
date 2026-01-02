import { Action, ActionPanel, Clipboard, Icon, Keyboard, Toast, showToast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { AppDetails } from "../types";
import { getAppStoreUrl } from "../utils/constants";
import { getAppMarkdown } from "./app-detail-content";

interface CopyActionsProps {
  app: AppDetails;
  isFavorited?: boolean;
}

/**
 * Reusable component for copy-related actions
 */
export function CopyActions({ app, isFavorited = false }: CopyActionsProps) {
  // Function to copy text to clipboard
  async function copyToClipboard(text: string, toastTitle: string) {
    try {
      await Clipboard.copy(text);
      showToast(Toast.Style.Success, toastTitle, "Copied to clipboard");
    } catch (error) {
      showFailureToast(error instanceof Error ? error : new Error("Could not copy to clipboard"), {
        title: "Failed to copy",
      });
    }
  }

  // Create a fallback App Store URL if trackViewUrl is not available
  const appStoreUrl = app.trackViewUrl || getAppStoreUrl(app.id);

  return (
    <ActionPanel.Section title="Copy">
      <Action
        title="Copy App Name"
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["cmd"], key: "n" }}
        onAction={() => copyToClipboard(app.name, "App Name")}
      />
      {app.version && (
        <Action
          title="Copy Version"
          icon={Icon.Clipboard}
          shortcut={{ modifiers: ["cmd"], key: "v" }}
          onAction={() => copyToClipboard(app.version, "App Version")}
        />
      )}
      <Action
        title="Copy Bundle ID"
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["cmd"], key: "b" }}
        onAction={() => copyToClipboard(app.bundleId, "Bundle Id")}
      />
      <Action
        title="Copy Developer"
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["cmd"], key: "d" }}
        onAction={() => copyToClipboard(app.sellerName || "Unknown Developer", "Developer")}
      />
      <Action
        title="Copy Description as Markdown"
        icon={Icon.QuoteBlock}
        shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
        onAction={() => copyToClipboard(getAppMarkdown(app, isFavorited), "Description as Markdown")}
      />
      <Action
        title="Copy App Store URL"
        icon={Icon.Link}
        shortcut={Keyboard.Shortcut.Common.Copy}
        onAction={() => copyToClipboard(appStoreUrl, "App Store URL")}
      />
      {app.artistViewUrl && (
        <Action
          title="Copy Developer URL"
          icon={Icon.Link}
          onAction={() => copyToClipboard(app.artistViewUrl!, "Developer URL")}
        />
      )}
    </ActionPanel.Section>
  );
}
