/**
 * CORS origin allowlist.
 *
 * Configured via the `ALLOWED_ORIGINS` environment variable — a comma-separated
 * list of origins that are permitted to call the API from a browser.
 *
 *   ALLOWED_ORIGINS=https://hub.example.com,https://staging.example.com
 *
 * Requests with no `Origin` header (Electron, native mobile, curl,
 * server-to-server) are always allowed — they are not browser-initiated and
 * therefore not subject to the same-origin policy.
 *
 * Browser requests whose `Origin` is not on the list receive a normal HTTP
 * response with NO `Access-Control-Allow-Origin` header, so the browser's SOP
 * enforcer blocks the response from reaching the calling page.
 *
 * The env var is read at request time (not at module load) so tests can
 * manipulate `process.env.ALLOWED_ORIGINS` between assertions.
 *
 * If the variable is unset, a dev-only fallback of `http://localhost:3050`
 * (the Vite dev server origin) is used. In production, `ecosystem.config.cjs`
 * sets an explicit value.
 */

import type { CorsOptions } from 'cors';

const DEV_FALLBACK_ORIGINS = ['http://localhost:3050'];

export function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (raw === undefined) {
    return [...DEV_FALLBACK_ORIGINS];
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // No Origin header → non-browser client (Electron, curl, native). Allow.
    if (!origin) {
      return callback(null, true);
    }
    const allowed = getAllowedOrigins();
    if (allowed.includes(origin)) {
      return callback(null, true);
    }
    // Unknown origin — respond without CORS headers; browser SOP blocks.
    return callback(null, false);
  },
  credentials: false,
};
