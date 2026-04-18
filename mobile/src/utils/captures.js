// Pure helpers for the mobile PR Captures viewer.
// Extracted so they can be unit-tested without rendering React Native.
//
// The server stores PR capture artifacts (screenshots + videos) on disk and
// exposes them under `<server>/uploads/captures/<captureId>/<filename>`.
// The `/uploads` path is intentionally unauthenticated, so mobile can load
// assets in <Image> / <Video> without passing the API key.

import { colors } from '../theme/colors';

/**
 * Strip the trailing `/api` (and any trailing slashes) from a base URL so we
 * can build `/uploads/...` asset URLs.
 *
 * @param {string|null|undefined} apiBase  e.g. "https://hub.example.com/api"
 * @returns {string}                        e.g. "https://hub.example.com"
 */
export function deriveServerBase(apiBase) {
  if (!apiBase || typeof apiBase !== 'string') return '';
  return apiBase.replace(/\/+$/, '').replace(/\/api$/, '');
}

/**
 * Build the public URL for a capture artifact (screenshot or video).
 *
 * @param {string} serverBase  Server root without `/api`
 * @param {string} captureId
 * @param {string} filename
 * @returns {string|null}
 */
export function buildCaptureAssetUrl(serverBase, captureId, filename) {
  if (!serverBase || !captureId || !filename) return null;
  // Don't touch filename casing/encoding — filenames are server-controlled.
  return `${serverBase.replace(/\/+$/, '')}/uploads/captures/${captureId}/${filename}`;
}

/**
 * Filter a list of captures to only those attached to a given PR number.
 * `prNumber` may be a string or a number — both are coerced to string.
 *
 * @param {Array<{pr_number: number|string}>} captures
 * @param {number|string|null|undefined} prNumber
 * @returns {Array}
 */
export function filterCapturesByPr(captures, prNumber) {
  if (!Array.isArray(captures)) return [];
  if (prNumber === null || prNumber === undefined || prNumber === '') return [];
  const wanted = String(prNumber);
  return captures.filter((c) => c && String(c.pr_number) === wanted);
}

/**
 * Partition a list of capture artifacts into screenshots, videos, and parsed
 * console-error entries. Mirrors the web CapturesPage logic so we stay in sync
 * when the web version adds new types.
 *
 * @param {Array} artifacts
 * @returns {{screenshots: Array, videos: Array, consoleErrors: Array<{route: string, error: any}>}}
 */
export function partitionArtifacts(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const screenshots = list.filter((a) => a && a.type === 'screenshot');
  const videos = list.filter((a) => a && a.type === 'video');
  const consoleErrors = [];
  for (const a of list) {
    if (!a || !a.console_errors) continue;
    const label = a.route || a.label || '';
    try {
      const parsed = JSON.parse(a.console_errors);
      if (Array.isArray(parsed)) {
        for (const err of parsed) consoleErrors.push({ route: label, error: err });
      } else {
        consoleErrors.push({ route: label, error: parsed });
      }
    } catch {
      consoleErrors.push({ route: label, error: a.console_errors });
    }
  }
  return { screenshots, videos, consoleErrors };
}

/**
 * Format a byte count as "1.2 MB", "200 KB", "500 B".
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a millisecond duration as "450ms", "32s", or "1m 05s".
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Map a capture status to a badge descriptor consistent with the web UI.
 *
 * @param {string} status
 * @returns {{label: string, color: string, bg: string}}
 */
export function captureStatusBadge(status) {
  switch (status) {
    case 'queued':
      return { label: 'Queued', color: colors.gray400, bg: colors.gray700_40 };
    case 'building':
      return { label: 'Building', color: colors.yellow400, bg: colors.yellow900_50 };
    case 'capturing':
      return { label: 'Capturing', color: colors.blue400, bg: colors.blue900_40 };
    case 'done':
      return { label: 'Done', color: colors.emerald400, bg: colors.emerald900_40 };
    case 'error':
      return { label: 'Error', color: colors.red400, bg: colors.red900_50 };
    default:
      return { label: status || 'Unknown', color: colors.gray400, bg: colors.gray700_40 };
  }
}
