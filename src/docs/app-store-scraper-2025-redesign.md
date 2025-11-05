# App Store Web Scraper: 2024 Redesign Update

## Overview

In 2024, Apple redesigned the App Store website and completely changed how screenshot data is embedded in the HTML. This document explains the new structure and how our scraper was updated to support it.

## The Problem

### Old Structure (Pre-2024)

The old App Store used a "shoebox" JSON format embedded in the HTML:

```html
<script type="fastboot/shoebox" id="shoebox-media-api-cache-apps">
  {
    "d": [{
      "attributes": {
        "platformAttributes": {
          "ios": {
            "customAttributes": {
              "default": {
                "default": {
                  "customScreenshotsByType": {
                    "iphone6+": [...],
                    "ipadPro": [...]
                  }
                }
              }
            }
          }
        }
      }
    }]
  }
</script>
```

This structure was **removed** in the 2024 redesign, breaking all screenshot scraping functionality.

## The New Structure (2024+)

### JSON Location

The new App Store embeds screenshot data in a different script tag:

```html
<script type="application/json" id="serialized-server-data">
  [{
    "intent": {...},
    "data": {
      "shelfMapping": {
        "product_media_phone_": {...},
        "product_media_pad_": {...},
        "product_media_mac_": {...},
        "product_media_vision_": {...}
      }
    }
  }]
</script>
```

### Data Structure

The JSON is an **array** (not an object) with the following structure:

```typescript
interface SerializedServerData {
  intent?: unknown;
  data?: {
    shelfMapping?: ShelfMapping;
  };
}

interface ShelfMapping {
  // Platform-specific media sections
  product_media_phone_?: PlatformMediaSection; // iPhone screenshots
  product_media_pad_?: PlatformMediaSection; // iPad screenshots
  product_media_mac_?: PlatformMediaSection; // Mac screenshots
  product_media_vision_?: PlatformMediaSection; // Vision Pro screenshots
  product_media_tv_?: PlatformMediaSection; // Apple TV screenshots (rare)
  product_media_watch_?: PlatformMediaSection; // Apple Watch screenshots (rare)
  // ... other keys
}

interface PlatformMediaSection {
  items: PlatformMediaItem[];
  contentsMetadata?: unknown;
}

interface PlatformMediaItem {
  screenshot: ScreenshotArtwork;
}

interface ScreenshotArtwork {
  checksum: string | null;
  backgroundColor: unknown;
  textColor: unknown;
  style: string | null;
  crop: string; // e.g., "bb" (bounding box)
  contentMode: string | null;
  imageScale: string | null;
  template: string; // URL template with placeholders
  width: number; // Original screenshot width
  height: number; // Original screenshot height
  variants: Array<{
    format: string; // e.g., "jpeg"
    quality: number; // e.g., 70
    supportsWideGamut: boolean;
  }>;
}
```

## Platform Mapping

The new structure uses different keys than the old one:

| Key                     | Platform   | Typical Dimensions       |
| ----------------------- | ---------- | ------------------------ |
| `product_media_phone_`  | iPhone     | 1284×2778 (6.7" Pro Max) |
| `product_media_pad_`    | iPad       | 2732×2048 (12.9" Pro)    |
| `product_media_mac_`    | Mac        | 2560×1600 (MacBook Pro)  |
| `product_media_vision_` | VisionPro  | 3840×2160 (4K)           |
| `product_media_tv_`     | AppleTV    | Varies (rare)            |
| `product_media_watch_`  | AppleWatch | Varies (rare)            |

## Building High-Resolution URLs

### URL Template Format

Each screenshot includes a `template` field with placeholders:

```
https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/42/fe/50/42fe5011-091e-71ce-1998-dd2f2a95825f/45baf245-dc52-4cd0-b535-2302dd97b292_Sofa_App_Store_Screenshot_1.png/{w}x{h}{c}.{f}
```

**Placeholders:**

- `{w}` - Width in pixels
- `{h}` - Height in pixels
- `{c}` - Crop mode (typically "bb" for bounding box)
- `{f}` - Format (e.g., "png", "jpg", "webp")

### Resolution Strategy

Apple's CDN provides the original dimensions in the `width` and `height` fields. To get the highest quality screenshots:

1. **Use the original dimensions** from the artwork object
2. **Use "bb" for crop** (bounding box - no cropping)
3. **Use "png" format** for highest quality

**Example URL construction:**

```typescript
const template = artwork.template;
const url = template.replace("{w}x{h}{c}.{f}", `${artwork.width}x${artwork.height}bb.png`);
```

**Result:**

```
https://is1-ssl.mzstatic.com/image/thumb/.../1284x2778bb.png
```

### Important Notes

❌ **Do NOT use `x0` format** - Apple's CDN does not support automatic height calculation

```typescript
// This will return HTTP 400:
template.replace("{w}x{h}{c}.{f}", "2560x0bb.png");
```

✅ **DO use exact dimensions** - Always use both width and height

```typescript
// This works:
template.replace("{w}x{h}{c}.{f}", "2560x1600bb.png");
```

## Implementation Example

Here's how to extract screenshots from the new format:

```typescript
export function extractScreenshotsFromSerializedData(html: string): ScreenshotInfo[] {
  const screenshots: ScreenshotInfo[] = [];

  // 1. Extract the JSON
  const regex = /<script type="application\/json" id="serialized-server-data">([\s\S]*?)<\/script>/i;
  const match = html.match(regex);

  if (!match || !match[1]) {
    return screenshots;
  }

  // 2. Parse the JSON (it's an array!)
  const serverData = JSON.parse(match[1]);
  const shelfMapping = serverData[0]?.data?.shelfMapping;

  if (!shelfMapping) {
    return screenshots;
  }

  // 3. Map platform keys to platform types
  const platformMap: Record<string, PlatformType> = {
    product_media_phone_: "iPhone",
    product_media_pad_: "iPad",
    product_media_mac_: "Mac",
    product_media_vision_: "VisionPro",
    product_media_tv_: "AppleTV",
    product_media_watch_: "AppleWatch",
  };

  // 4. Extract screenshots from each platform
  let index = 0;
  for (const [key, platformType] of Object.entries(platformMap)) {
    const section = shelfMapping[key];

    if (!section?.items) continue;

    for (const item of section.items) {
      if (!item.screenshot?.template) continue;

      const artwork = item.screenshot;

      // Build the highest quality URL
      const url = artwork.template.replace("{w}x{h}{c}.{f}", `${artwork.width}x${artwork.height}bb.png`);

      screenshots.push({
        url,
        type: platformType,
        index: index++,
      });
    }
  }

  return screenshots;
}
```

## Real-World Example

Testing with the **Sofa: Downtime Organizer** app (ID: 1276554886):

### Data Found

- **iPhone**: 10 screenshots at 1284×2778
- **iPad**: 10 screenshots at 2732×2048
- **Mac**: 10 screenshots at 2560×1600
- **Vision Pro**: 9 screenshots at 3840×2160

### Sample URLs

```
iPhone:
https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/42/fe/50/42fe5011-091e-71ce-1998-dd2f2a95825f/45baf245-dc52-4cd0-b535-2302dd97b292_Sofa_App_Store_Screenshot_1.png/1284x2778bb.png

iPad:
https://is1-ssl.mzstatic.com/image/thumb/PurpleSource211/v4/46/40/b9/4640b9e6-7d06-a19c-b869-204ea2f2aad0/f043e7b9-6fee-413e-ad99-a4bde0890fc0_Sofa_App_Store_Screenshot_1.png/2732x2048bb.png

Mac:
https://is1-ssl.mzstatic.com/image/thumb/PurpleSource211/v4/98/81/f0/9881f0be-8cc8-e421-2697-aa4086bf8344/24ce6af8-ae30-42c0-bdc7-88f201e5e3fb_Sofa_App_Store_Screenshot_1.png/2560x1600bb.png

Vision Pro:
https://is1-ssl.mzstatic.com/image/thumb/PurpleSource211/v4/19/33/c2/1933c205-5b8b-b0e0-d423-c88fb3b2e99c/c31a6af7-2a7e-464d-aea5-3cbfb50df12a_Sofa_App_Store_Screenshot_1.png/3840x2160bb.png
```

All URLs return **HTTP 200** with high-quality PNG images.

## Quality Comparison

### Before (iTunes API)

- iPhone: 392×696 or smaller
- iPad: 552×414 or smaller
- Limited to iPhone, iPad, and Apple TV only
- No Mac or Vision Pro support

### After (Web Scraper)

- iPhone: 1284×2778 (**3.3× larger**)
- iPad: 2732×2048 (**4.9× larger**)
- Mac: 2560×1600 (**NEW**)
- Vision Pro: 3840×2160 (**NEW**)
- Apple Watch: When available (**NEW**)

## Browser Detection

When fetching the App Store page, you may want to include headers to ensure you get the full data:

```typescript
const response = await fetch(appStoreUrl, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
});
```

## Debugging Tips

### Check if the JSON exists

```typescript
const hasOldFormat = html.includes("shoebox-media-api-cache-apps");
const hasNewFormat = html.includes("serialized-server-data");

console.log({ hasOldFormat, hasNewFormat });
// Expected: { hasOldFormat: false, hasNewFormat: true }
```

### Inspect the JSON structure

```typescript
const match = html.match(/<script type="application\/json" id="serialized-server-data">([\s\S]*?)<\/script>/i);
if (match) {
  const data = JSON.parse(match[1]);
  console.log("Keys:", Object.keys(data[0]?.data?.shelfMapping || {}));
  // Expected: ['product_media_phone_', 'product_media_pad_', ...]
}
```

### Verify URL construction

```typescript
const testUrl = "https://.../template.png/{w}x{h}{c}.{f}";
const finalUrl = testUrl.replace("{w}x{h}{c}.{f}", "1284x2778bb.png");
console.log(finalUrl);
// Should NOT contain any curly braces
```

### Test URL validity

```bash
curl -I "https://is1-ssl.mzstatic.com/.../1284x2778bb.png"
# Should return HTTP/2 200
```

## Migration Checklist

If you're updating an existing scraper:

- [ ] Remove references to `shoebox-media-api-cache-apps`
- [ ] Remove old device type mappings (e.g., `iphone6+`, `ipadPro`)
- [ ] Update to parse `serialized-server-data` instead
- [ ] Update platform keys to new format (`product_media_*`)
- [ ] Use URL templates with exact dimensions
- [ ] Test with multiple apps to verify all platforms
- [ ] Add support for new platforms (Mac, Vision Pro)
- [ ] Update documentation and comments

## Future Considerations

⚠️ **Apple may change this structure at any time**

To future-proof the scraper:

1. Always validate the JSON structure before parsing
2. Log warnings when expected keys are missing
3. Fail gracefully if the format changes
4. Consider maintaining both old and new parsers temporarily
5. Monitor for HTTP errors when fetching screenshots

## Additional Resources

- **App Store Base URL**: `https://apps.apple.com/`
- **Example URL**: `https://apps.apple.com/us/app/sofa-downtime-organizer/id1276554886`
- **CDN Base**: `https://is1-ssl.mzstatic.com/` (or is2, is3, etc.)
- **Image Path Pattern**: `/image/thumb/[Source]/v4/[hash]/[uuid]/[filename].png/[dimensions][crop].[format]`

## Questions?

If the scraper breaks in the future:

1. First, check if the `serialized-server-data` script tag still exists
2. Verify the structure of the shelfMapping object
3. Look for new platform keys (e.g., `product_media_*`)
4. Check if Apple changed the URL template format
5. Test with multiple apps to rule out app-specific issues

---

**Last Updated**: November 4, 2024  
**App Store Version**: 2024 Redesign  
**Tested With**: Sofa app (ID: 1276554886)
