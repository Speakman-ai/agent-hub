/**
 * Normalize href/src values in assistant markdown so server-hosted files
 * (/uploads, /design-files) load through the same origin as the UI.
 *
 * - Remote mode: prefix relative `/uploads/...` with `getServerBase()` (matches
 *   MessageAttachments).
 * - Vite dev (UI on :3050, API on VITE_API_PORT): rewrite
 *   `http://localhost:<apiPort>/uploads/...` to a path-only URL so the dev
 *   proxy serves the file (fixes images/links that would otherwise hit the
 *   wrong origin).
 */

import { getServerBase } from './connection.js';

const SERVER_PATH_PREFIXES = ['/uploads/', '/design-files/'];

function isServerHostedPathname(pathname) {
  return SERVER_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * @param {string | null | undefined} raw
 * @param {{ serverBase?: string; viteApiPort?: string }} [opts]
 * @returns {string | null | undefined}
 */
export function resolveServerMediaUrl(raw, opts = {}) {
  if (raw == null || typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.toLowerCase().startsWith('javascript:')
  ) {
    return raw;
  }

  const serverBase = opts.serverBase !== undefined ? opts.serverBase : getServerBase();
  const viteApiPort =
    opts.viteApiPort !== undefined ? opts.viteApiPort : (import.meta.env?.VITE_API_PORT ?? '');

  const pathOnly = trimmed.split('?')[0].split('#')[0];
  if (trimmed.startsWith('/') && isServerHostedPathname(pathOnly)) {
    return serverBase ? `${serverBase.replace(/\/+$/, '')}${trimmed}` : trimmed;
  }

  // Local / same-install dev only: never apply when a remote base is configured.
  if (viteApiPort && !serverBase && /^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      if (
        (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
        u.port === String(viteApiPort) &&
        isServerHostedPathname(u.pathname)
      ) {
        return `${u.pathname}${u.search}${u.hash}`;
      }
    } catch {
      /* ignore invalid URLs */
    }
  }

  return raw;
}
