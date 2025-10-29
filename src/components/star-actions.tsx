import { Action, Icon, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { AppDetails } from "../types";
import { addStarredApp, removeStarredApp, isAppStarred } from "../utils/storage";

interface StarActionsProps {
  app: AppDetails;
}

/**
 * Component for starring/unstarring apps
 */
export function StarActions({ app }: StarActionsProps) {
  const [isStarred, setIsStarred] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Check if app is starred on mount
  useEffect(() => {
    const checkStarStatus = async () => {
      try {
        const starred = await isAppStarred(app.bundleId);
        setIsStarred(starred);
      } catch (error) {
        console.error("Error checking star status:", error);
      } finally {
        setIsLoading(false);
      }
    };

    checkStarStatus();
  }, [app.bundleId]);

  const handleToggleStar = async () => {
    try {
      if (isStarred) {
        await removeStarredApp(app.bundleId);
        setIsStarred(false);
        await showToast({
          style: Toast.Style.Success,
          title: "Removed from Favorites",
          message: `${app.name} removed from favorites`,
        });
      } else {
        await addStarredApp(app);
        setIsStarred(true);
        await showToast({
          style: Toast.Style.Success,
          title: "Added to Favorites",
          message: `${app.name} added to favorites`,
        });
      }
    } catch (error) {
      console.error("Error toggling star status:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Update Favorites",
        message: "Could not update favorite status",
      });
    }
  };

  if (isLoading) {
    return null; // Don't render until we know the status
  }

  return (
    <Action
      title={isStarred ? "Remove from Favorites" : "Add to Favorites"}
      icon={isStarred ? Icon.StarDisabled : Icon.Star}
      onAction={handleToggleStar}
      shortcut={{ modifiers: ["cmd"], key: "f" }}
    />
  );
}
