import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, extname, join } from "path";
import { logger } from "@chrismessina/raycast-logger";
import { useCallback } from "react";
import { Clipboard, showInFinder, showToast, Toast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { stringifyError } from "../utils/log-actions";
import { useFavoriteApps, type FavoriteApp } from "./use-favorite-apps";

/**
 * House style: every failure toast offers the error on the clipboard.
 * `showFailureToast` renders one line; the stack is what makes a report useful.
 */
function copyErrorAction(error: unknown): Toast.ActionOptions {
  return {
    title: "Copy Error",
    onAction: (toast) => {
      Clipboard.copy(stringifyError(error) ?? "Unknown error");
      toast.hide();
    },
  };
}

/**
 * Quote one CSV cell, neutralising spreadsheet formula injection.
 *
 * RFC 4180 quoting alone does NOT stop a spreadsheet executing a cell: Excel, Sheets
 * and Numbers all evaluate a value beginning `=`, `+`, `-`, `@`, or a leading tab or
 * carriage return, quoted or not. `name` and `sellerName` come straight from the iTunes
 * API, so an app called `=HYPERLINK("http://evil","click")` would land as a live formula
 * in the user's sheet. The leading apostrophe is the standard neutralisation and
 * spreadsheets strip it on display.
 *
 * Applied to every column rather than per-field, so a newly added column cannot forget it.
 */
function csvCell(value: string): string {
  const neutralised = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${neutralised.replace(/"/g, '""')}"`;
}

/**
 * Write an export into ~/Downloads and return the path actually used.
 *
 * `mkdir` first: ~/Downloads is not guaranteed to exist, and without it an export on
 * such a machine fails with a bare ENOENT. `flag: "wx"` then refuses to clobber an
 * existing file — a plain existsSync check races its own write — and collisions fall
 * back to `name 2`, `name 3`, … the way the Finder does.
 */
async function writeExport(fileName: string, contents: string): Promise<string> {
  const directory = join(homedir(), "Downloads");
  await mkdir(directory, { recursive: true });

  const extension = extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);

  for (let attempt = 1; ; attempt++) {
    const candidate = join(directory, attempt === 1 ? fileName : `${stem} ${attempt}${extension}`);
    try {
      await writeFile(candidate, contents, { encoding: "utf-8", flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

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
      csvCell(app.name),
      csvCell(app.sellerName),
      csvCell(app.version),
      csvCell(String(app.price)),
      csvCell(app.currency),
      csvCell(app.bundleId),
      csvCell(new Date(item.favoritedDate).toLocaleDateString()),
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
      const downloadsPath = await writeExport(fileName, markdown);

      await showToast({
        style: Toast.Style.Success,
        title: "Export Complete",
        message: `Favorites saved to ${basename(downloadsPath)}`,
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
      logger.error("[export] Markdown export failed:", error);
      await showFailureToast(error, { title: "Export Failed", primaryAction: copyErrorAction(error) });
    }
  }, [favoriteApps]);

  // Export to CSV file
  const exportToCSV = useCallback(async () => {
    try {
      const csv = generateCSV(favoriteApps);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
      const fileName = `favorite-ios-apps-${timestamp}.csv`;
      const downloadsPath = await writeExport(fileName, csv);

      await showToast({
        style: Toast.Style.Success,
        title: "Export Complete",
        message: `Favorites saved to ${basename(downloadsPath)}`,
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
      logger.error("[export] CSV export failed:", error);
      await showFailureToast(error, { title: "Export Failed", primaryAction: copyErrorAction(error) });
    }
  }, [favoriteApps]);

  return {
    exportToMarkdown,
    exportToCSV,
  };
}
