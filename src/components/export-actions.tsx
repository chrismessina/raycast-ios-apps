import { ActionPanel, Action, Icon } from "@raycast/api";
import { useExportFavorites } from "../hooks";

/**
 * Reusable export actions for favorite apps
 */
export function ExportActions() {
  const { exportToMarkdown, exportToCSV } = useExportFavorites();

  return (
    <ActionPanel.Section title="Export">
      <Action
        title="Export Favorites to Markdown"
        onAction={exportToMarkdown}
        icon={Icon.Document}
        shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
      />
      <Action
        title="Export Favorites to CSV"
        onAction={exportToCSV}
        icon={Icon.Document}
        shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
      />
    </ActionPanel.Section>
  );
}
