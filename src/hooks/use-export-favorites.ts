import { showToast, Toast, showInFinder, Clipboard } from "@raycast/api";
import { useCallback } from "react";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { useFavoriteApps, type FavoriteApp } from "./use-favorite-apps";

/**
 * Generate markdown content from favorite apps
 */
function generateMarkdown(favoriteApps: FavoriteApp[]): string {
  if (favoriteApps.length === 0) {
    return "# No Favorite Apps\n\nYou haven't favorited any apps yet.";
  }

  let markdown = "# Favorite iOS Apps\n\n";
  markdown += `Generated on ${new Date().toLocaleDateString()}\n\n`;

  for (const item of favoriteApps) {
    const app = item.app;
    markdown += `## ${app.name}\n\n`;
    markdown += `- **Developer:** ${app.sellerName}\n`;
    markdown += `- **Version:** ${app.version}\n`;
    markdown += `- **Price:** ${app.price} ${app.currency}\n`;
    markdown += `- **Bundle ID:** \`${app.bundleId}\`\n`;
    markdown += `- **Favorited:** ${new Date(item.favoritedDate).toLocaleDateString()}\n`;

    if (app.description) {
      const shortDesc = app.description.length > 200 ? app.description.substring(0, 200) + "..." : app.description;
      markdown += `- **Description:** ${shortDesc}\n`;
    }

    markdown += "\n";
  }

  return markdown;
}

/**
 * Generate CSV content from favorite apps
 */
function generateCSV(favoriteApps: FavoriteApp[]): string {
  if (favoriteApps.length === 0) {
    return "Name,Developer,Version,Price,Currency,Bundle ID,Favorited Date\n";
  }

  let csv = "Name,Developer,Version,Price,Currency,Bundle ID,Favorited Date\n";

  for (const item of favoriteApps) {
    const app = item.app;
    const row = [
      `"${app.name.replace(/"/g, '""')}"`, // Escape quotes in CSV
      `"${app.sellerName.replace(/"/g, '""')}"`,
      `"${app.version}"`,
      `"${app.price}"`,
      `"${app.currency}"`,
      `"${app.bundleId}"`,
      `"${new Date(item.favoritedDate).toLocaleDateString()}"`,
    ];
    csv += row.join(",") + "\n";
  }

  return csv;
}

/**
 * Hook for exporting favorite apps to Markdown or CSV files
 */
export function useExportFavorites() {
  const { favoriteApps } = useFavoriteApps();

  // Export to markdown file
  const exportToMarkdown = useCallback(async () => {
    try {
      const markdown = generateMarkdown(favoriteApps);
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
  }, [favoriteApps]);

  // Export to CSV file
  const exportToCSV = useCallback(async () => {
    try {
      const csv = generateCSV(favoriteApps);
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
  }, [favoriteApps]);

  return {
    exportToMarkdown,
    exportToCSV,
  };
}
