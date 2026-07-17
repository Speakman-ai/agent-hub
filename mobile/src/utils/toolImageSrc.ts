import { getServerBaseUrl } from './config';

export interface ToolImageRef {
  mediaType?: string;
  dataBase64?: string;
  url?: string;
}

/**
 * Resolve a renderable `uri` for a tool_result image ref.
 *
 * - Absolute URLs (URL-source images) pass through unchanged.
 * - Relative `/uploads/...` asset paths resolve against the server root via
 *   `getServerBaseUrl()`, which already excludes the `/api` suffix. This avoids
 *   the earlier `getApiBaseUrl().replace('/api', '')` bug that corrupted hosts
 *   like `https://api.example.com/api` (the first `/api` matched inside the
 *   hostname).
 * - Otherwise falls back to an inline base64 data URL.
 */
export function resolveToolImageSrc(img: ToolImageRef | null | undefined): string | null {
  if (!img) return null;
  if (typeof img.url === 'string' && img.url) {
    if (/^https?:\/\//i.test(img.url)) return img.url;
    return `${getServerBaseUrl()}${img.url}`;
  }
  if (typeof img.dataBase64 === 'string' && img.dataBase64) {
    return `data:${img.mediaType || 'image/png'};base64,${img.dataBase64}`;
  }
  return null;
}
