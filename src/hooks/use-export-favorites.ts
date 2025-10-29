import { showToast, Toast, showInFinder, Clipboard } from "@raycast/api";
import { useCallback } from "react";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { exportStarredToMarkdown, exportStarredToCSV } from "../utils/storage";

/**
 * Hook for exporting favorite apps to Markdown or CSV files
 */
export function useExportFavorites() {
  // Export to markdown file
  const exportToMarkdown = useCallback(async () => {
    try {
      const markdown = await exportStarredToMarkdown();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
      const fileName = `favorite-ios-apps-${timestamp}.md`;
      const downloadsPath = join(homedir(), "Downloads", fileName);

      await writeFile(downloadsPath, markdown, "utf-8");
      await showToast({
        style: Toast.Style.Success,
        title: "Export Complete",
        message: `Favorites saved to ${fileName}`,
        primaryAction: {
          title: "Show in Finder",
          shortcut: { modifiers: ["cmd"], key: "o" },
          onAction: async () => {
            await showInFinder(downloadsPath);
          },
        },
        secondaryAction: {
          title: "Copy Path",
          shortcut: { modifiers: ["cmd"], key: "c" },
          onAction: async (toast) => {
            await Clipboard.copy(downloadsPath);
            toast.message = "Path copied to clipboard";
          },
        },
      });
    } catch (error) {
      console.error("Error exporting to markdown:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Export Failed",
        message: "Could not export favorite apps",
      });
    }
  }, []);

  // Export to CSV file
  const exportToCSV = useCallback(async () => {
    try {
      const csv = await exportStarredToCSV();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
      const fileName = `favorite-ios-apps-${timestamp}.csv`;
      const downloadsPath = join(homedir(), "Downloads", fileName);

      await writeFile(downloadsPath, csv, "utf-8");
      await showToast({
        style: Toast.Style.Success,
        title: "Export Complete",
        message: `Favorites saved to ${fileName}`,
        primaryAction: {
          title: "Show in Finder",
          shortcut: { modifiers: ["cmd"], key: "o" },
          onAction: async () => {
            await showInFinder(downloadsPath);
          },
        },
        secondaryAction: {
          title: "Copy Path",
          shortcut: { modifiers: ["cmd"], key: "c" },
          onAction: async (toast) => {
            await Clipboard.copy(downloadsPath);
            toast.message = "Path copied to clipboard";
          },
        },
      });
    } catch (error) {
      console.error("Error exporting to CSV:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Export Failed",
        message: "Could not export favorite apps",
      });
    }
  }, []);

  return {
    exportToMarkdown,
    exportToCSV,
  };
}
