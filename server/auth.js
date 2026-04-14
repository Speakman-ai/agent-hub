/**
 * Optional API key authentication middleware.
 *
 * When `AGENT_HUB_API_KEY` is set (env var or config.json), all API
 * requests must include the key via:
 *   - `X-API-Key` header, OR
 *   - `?apiKey=` query parameter
 *
 * When no key is configured, auth is disabled — backward compatible.
 * The `/api/health` endpoint is always public (used for connection testing).
 */

import config from './config.js';

const PUBLIC_PATHS = [
  '/api/health',
  '/api/github-app/callback',
  '/api/github-app/setup-complete',
  '/api/github-app/register',
];

export function authMiddleware(req, res, next) {
  const apiKey = config.apiKey;

  // No key configured → auth disabled (local-only mode)
  if (!apiKey) return next();

  // Only gate API routes — static files / SPA fallback serve without auth
  if (!req.path.startsWith('/api/')) return next();

  // Public API endpoints bypass auth
  if (PUBLIC_PATHS.includes(req.path)) return next();

  // Check header first, then query param
  const provided = req.headers['x-api-key'] || req.query.apiKey;

  if (!provided) {
    return res
      .status(401)
      .json({ error: 'API key required. Set X-API-Key header or ?apiKey= query param.' });
  }

  if (provided !== apiKey) {
    return res.status(403).json({ error: 'Invalid API key.' });
  }

  next();
}

/**
 * Validate a WebSocket connection's API key.
 * Checks the `?apiKey=` query param on the upgrade request.
 * Returns true if auth passes (or no key is configured).
 */
export function authenticateWs(request) {
  const apiKey = config.apiKey;
  if (!apiKey) return true; // no auth configured

  const url = new URL(request.url, `http://${request.headers.host}`);
  const provided = url.searchParams.get('apiKey');
  return provided === apiKey;
}
