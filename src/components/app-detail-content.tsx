// Shared component for rendering app detail metadata
import { Detail, Color, Icon } from "@raycast/api";
import { AppDetails } from "../types";
import { formatPrice, formatDate } from "../utils/formatting";
import { renderStarRating } from "../utils/common";
import { getAppStoreUrl } from "../utils/constants";

interface AppDetailContentProps {
  app: AppDetails;
  isFavorited?: boolean;
}

export function AppDetailContent({ app, isFavorited = false }: AppDetailContentProps) {
  // Function to format file size to human-readable format (e.g., KB, MB, GB)
  function formatFileSize(bytes: number | string): string {
    if (!bytes || bytes === 0 || bytes === "0") return "Unknown";

    const bytesNum = typeof bytes === "string" ? parseInt(bytes, 10) : bytes;

    if (isNaN(bytesNum) || bytesNum === 0) return "Unknown";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytesNum) / Math.log(k));
    return parseFloat((bytesNum / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  // Get the app icon URL with fallbacks
  const iconUrl = app.artworkUrl512 || app.artworkUrl60 || app.iconUrl || "";

  // Create a fallback App Store URL if trackViewUrl is not available
  const appStoreUrl = app.trackViewUrl || getAppStoreUrl(app.id);

  // Get the app rating
  const rating = app.averageUserRatingForCurrentVersion || app.averageUserRating;
  const ratingCount = app.userRatingCountForCurrentVersion || app.userRatingCount;
  const ratingText = rating ? `${rating.toFixed(1)} ${renderStarRating(rating)}` : "No Rating";

  // Format rating count with K/M suffix
  let ratingCountText = "No Ratings";
  if (ratingCount) {
    if (ratingCount >= 1000000) {
      ratingCountText = `${(ratingCount / 1000000).toFixed(1)}M Ratings`;
    } else if (ratingCount >= 1000) {
      ratingCountText = `${(ratingCount / 1000).toFixed(1)}K Ratings`;
    } else {
      ratingCountText = `${ratingCount} Ratings`;
    }
  }

  // Format release dates
  const releaseDate = formatDate(app.releaseDate);
  const currentVersionReleaseDate = formatDate(app.currentVersionReleaseDate);

  return {
    markdown: `
## ${app.name} (${app.version})${isFavorited ? " ♥" : ""}

${iconUrl && `![App Icon](${iconUrl}?raycast-width=128&raycast-height=128)`}

${app.description || "No description available"}

${
  app.screenshotUrls && app.screenshotUrls.length > 0
    ? `
### Screenshots

${app.screenshotUrls.map((url, index) => `![Screenshot ${index + 1}](${url}?raycast-width=128)`).join(" ")}
`
    : ""
}
    `,
    metadata: (
      <Detail.Metadata>
        <Detail.Metadata.TagList title="Genres">
          {app.genres && app.genres.length > 0 ? (
            app.genres.map((genre) => (
              <Detail.Metadata.TagList.Item key={genre} text={genre} color={Color.PrimaryText} />
            ))
          ) : (
            <Detail.Metadata.TagList.Item text="No genres available" color={Color.SecondaryText} />
          )}
        </Detail.Metadata.TagList>

        <Detail.Metadata.Label title="Developer" text={app.sellerName || "Unknown Developer"} icon={Icon.Person} />

        {app.price && parseFloat(app.price) > 0 && (
          <Detail.Metadata.Label title="Price" text={formatPrice(app.price, app.currency)} icon={Icon.BankNote} />
        )}

        <Detail.Metadata.Label title={ratingCountText} text={ratingText} icon={Icon.Star} />

        <Detail.Metadata.Separator />

        <Detail.Metadata.Label title="Version" text={app.version} icon={Icon.Tag} />

        <Detail.Metadata.Label title="Updated" text={currentVersionReleaseDate} icon={Icon.Clock} />

        <Detail.Metadata.Label title="Released" text={releaseDate} icon={Icon.Calendar} />

        <Detail.Metadata.Label title="Size" text={formatFileSize(app.size)} icon={Icon.HardDrive} />

        <Detail.Metadata.Separator />

        <Detail.Metadata.Link title="View in App Store" target={appStoreUrl} text="Open App Store" />

        {app.artistViewUrl && (
          <Detail.Metadata.Link title="Developer Website" target={app.artistViewUrl} text="View Developer" />
        )}
      </Detail.Metadata>
    ),
  };
}
