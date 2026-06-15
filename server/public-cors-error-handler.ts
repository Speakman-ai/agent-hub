import type { ErrorRequestHandler, Response } from 'express';

/**
 * Public, no-auth ingest endpoints that advertise permissive CORS
 * (`Access-Control-Allow-Origin: *`) so first-party widgets running on
 * arbitrary third-party origins can POST to them:
 *
 *   - the rrweb session-replay recorder  → POST /api/replays
 *                                           POST /api/replays/:id/events
 *   - the embeddable bug-report widget    → POST /api/bug-reports
 *
 * Each of those routes mounts its own `applyCors` middleware, but that only
 * runs once the request reaches the router. A failure in the GLOBAL body
 * parser (`express.json({ limit: '20mb' })` in index.ts) — an oversized or
 * malformed body — throws BEFORE the router is reached, so the response is
 * produced by Express's default error handler with NO CORS headers. Because
 * these callers live on origins that are not in `ALLOWED_ORIGINS`, the global
 * `cors()` middleware also adds nothing, so the browser reports a misleading
 * "CORS error" instead of the honest 413 / 400.
 *
 * This error-handling middleware stamps the permissive CORS headers on those
 * error responses (and maps the common body-parser failures to honest status
 * codes) so failures surface as real HTTP errors the caller can read.
 */
const PUBLIC_CORS_PATHS: readonly RegExp[] = [
  /^\/api\/replays(?:\/[^/]+\/events)?\/?$/,
  /^\/api\/bug-reports\/?$/,
];

export function isPublicCorsPath(path: string): boolean {
  return PUBLIC_CORS_PATHS.some((re) => re.test(path));
}

function setPermissiveCors(res: Response): void {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  // Superset of the per-route allow-headers (replays uses X-Requested-With,
  // bug-reports also uses X-Filename / X-RUM-Token) so a preflight-cached
  // request never trips on a missing allowed header here.
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Filename, X-Requested-With, X-RUM-Token',
  );
  res.header('Access-Control-Max-Age', '600');
}

interface BodyParserError {
  type?: string;
  status?: number;
  statusCode?: number;
}

/**
 * Mount AFTER all routers (it is error-handling middleware). For the public
 * permissive-CORS ingest paths it always stamps the CORS headers, then:
 *   - 413 for `entity.too.large` (oversized body)
 *   - 400 for `entity.parse.failed` / `SyntaxError` (malformed JSON)
 *   - delegates anything else to the next error handler WITH the CORS headers
 *     already set on the response, so even a default 500 carries them.
 * Non-public paths and already-sent responses are passed straight through.
 */
export const publicCorsErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent || !isPublicCorsPath(req.path)) {
    next(err);
    return;
  }

  setPermissiveCors(res);

  const e = (err ?? {}) as BodyParserError;
  const status = e.status ?? e.statusCode;

  if (e.type === 'entity.too.large' || status === 413) {
    res.status(413).json({ error: 'Payload too large' });
    return;
  }

  if (e.type === 'entity.parse.failed' || err instanceof SyntaxError || status === 400) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }

  // Unknown error: headers are stamped; let the default/next handler send it
  // (the CORS headers we set persist on the response object).
  next(err);
};
