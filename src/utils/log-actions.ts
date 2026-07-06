import { promises as fs } from "fs";
import { homedir } from "os";
import path from "path";
import { Clipboard, showToast, Toast } from "@raycast/api";

interface CopyLogsContext {
  title: string;
  message?: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

function stringifyError(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }

  if (error instanceof Error) {
    return error.stack || error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

async function getRecentRaycastLogExcerpts(): Promise<string[]> {
  const logDirectories = [
    path.join(homedir(), "Library/Logs/com.raycast-x.macos"),
    path.join(homedir(), "Library/Logs/com.raycast.macos"),
    path.join(homedir(), "Library/Logs/Raycast"),
  ];

  for (const logDirectory of logDirectories) {
    try {
      const entries = await fs.readdir(logDirectory, { withFileTypes: true });
      const logFiles = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().includes("raycast"))
          .map(async (entry) => {
            const filePath = path.join(logDirectory, entry.name);
            const stats = await fs.stat(filePath);
            return { filePath, modifiedAt: stats.mtimeMs };
          }),
      );

      const excerpts = await Promise.all(
        logFiles
          .sort((a, b) => b.modifiedAt - a.modifiedAt)
          .slice(0, 2)
          .map(async ({ filePath }) => {
            const content = await fs.readFile(filePath, "utf8");
            const tail = content.split("\n").slice(-200).join("\n").slice(-20000);
            return [`Log file: ${filePath}`, tail].join("\n");
          }),
      );

      if (excerpts.length > 0) {
        return excerpts;
      }
    } catch {
      // Try the next known Raycast log location.
    }
  }

  return [];
}

export function createCopyLogsAction(context: CopyLogsContext): Toast.ActionOptions {
  return {
    title: "Copy Logs",
    shortcut: { modifiers: ["cmd", "shift"], key: "c" },
    onAction: async (toast) => {
      const logExcerpts = await getRecentRaycastLogExcerpts();
      const lines = [
        `iOS Apps Extension: ${context.title}`,
        context.message ? `Message: ${context.message}` : undefined,
        context.error ? `Error: ${stringifyError(context.error)}` : undefined,
        context.metadata ? `Metadata: ${JSON.stringify(context.metadata, null, 2)}` : undefined,
        "",
        logExcerpts.length > 0 ? "Recent Raycast logs:" : "Raycast logs were not readable from known locations.",
        ...logExcerpts,
      ].filter(Boolean);

      await Clipboard.copy(lines.join("\n"));
      toast.message = "Logs copied";
      await showToast({ style: Toast.Style.Success, title: "Copied Logs" });
    },
  };
}
