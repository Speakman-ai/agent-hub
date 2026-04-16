/**
 * capture.js — Shared helpers for preview capture data.
 *
 * Used by CaptureGallery in PreviewsPage.jsx and tested in PreviewCapture.test.js.
 */

/**
 * Separate capture artifacts into screenshots and videos.
 */
export function buildCaptureArtifacts(captures) {
  const screenshots = captures.filter((c) => c.type === 'screenshot');
  const videos = captures.filter((c) => c.type === 'video');
  return { screenshots, videos };
}

/**
 * Format a file size in bytes to a human-readable string.
 */
export function formatCaptureSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build a full URL to an uploaded capture artifact.
 */
export function buildUploadsUrl(serverBase, filePath) {
  return `${serverBase}/uploads/${filePath}`;
}
