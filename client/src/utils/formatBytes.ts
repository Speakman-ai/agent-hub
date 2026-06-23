/**
 * Human-readable size for skill injection / byte counts. Shared by session UI.
 * @param {number} bytes
 * @returns {string}
 */
export function formatInjectedBytes(bytes: any) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
