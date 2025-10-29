import { Action, Icon } from "@raycast/api";
import { AppDetails } from "../types";

interface FavoriteActionsProps {
  app: AppDetails;
  isFavorited: boolean;
  onAddFavorite: (app: AppDetails) => Promise<void>;
  onRemoveFavorite: (bundleId: string) => Promise<void>;
}

/**
 * Component for favoriting/unfavoriting apps
 */
export function FavoriteActions({ app, isFavorited, onAddFavorite, onRemoveFavorite }: FavoriteActionsProps) {
  const handleToggleFavorite = async () => {
    if (isFavorited) {
      await onRemoveFavorite(app.bundleId);
    } else {
      await onAddFavorite(app);
    }
  };

  return (
    <Action
      title={isFavorited ? "Remove from Favorites" : "Add to Favorites"}
      icon={isFavorited ? Icon.HeartDisabled : Icon.Heart}
      onAction={handleToggleFavorite}
      shortcut={{ modifiers: ["cmd"], key: "f" }}
    />
  );
}
