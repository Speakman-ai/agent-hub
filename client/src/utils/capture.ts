/**
 * capture.js — Shared helpers for preview capture data.
 *
 * Used by CaptureGallery in PreviewsPage.jsx and tested in PreviewCapture.test.js.
 */

/**
 * Separate capture artifacts into screenshots and videos.
 */
export function buildCaptureArtifacts(captures: any) {
  const screenshots = captures.filter((c: any) => c.type === 'screenshot');
  const videos = captures.filter((c: any) => c.type === 'video');
  return { screenshots, videos };
}

/**
 * Format a file size in bytes to a human-readable string.
 */
export function formatCaptureSize(bytes: any) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build a full URL to an uploaded capture artifact.
 */
export function buildUploadsUrl(serverBase: any, filePath: any) {
  return `${serverBase}/uploads/${filePath}`;
}
