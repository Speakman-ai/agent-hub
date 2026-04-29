import type { Request, Response, NextFunction } from 'express';

/**
 * URI-safety guard for Express.
 *
 * Express's router calls `decodeURIComponent` on path parameters during
 * layer matching (see `express/lib/router/layer.js → decode_param`). When
 * a probe/scanner sends a path containing an invalid percent sequence
 * (e.g. `/%c0`) the router throws an unhandled `URIError`, which our
 * default error path logs as a noisy stack trace.
 *
 * We split this into two layers:
 *
 *   1. `uriDecodeGuard` — a pre-router middleware that pre-validates the
 *      request's path with `decodeURIComponent`. On failure it short-
 *      circuits with a 400 so the request never reaches a `:param` layer.
 *
 *   2. `uriErrorHandler` — a final Express error-handling middleware
 *      (signature `(err, req, res, next)`) that catches any `URIError`
 *      raised from deeper in the stack (defense in depth — e.g. if a
 *      route registers an unusual layer that re-decodes the URL).
 *
 * Both branches respond with 400 + `{ error: 'malformed_uri' }` and
 * intentionally do NOT log a stack trace, since the dominant source is
 * untrusted bot traffic and not an internal bug.
 */

function isMalformedUri(rawUrl: string): boolean {
  try {
    // The path matters most — query strings hit `qs` which has its own
    // tolerant decoder. Strip the query before validating.
    const queryIdx = rawUrl.indexOf('?');
    const pathOnly = queryIdx >= 0 ? rawUrl.slice(0, queryIdx) : rawUrl;
    decodeURIComponent(pathOnly);
    return false;
  } catch (err) {
    return err instanceof URIError;
  }
}

export function uriDecodeGuard(req: Request, res: Response, next: NextFunction): void {
  if (isMalformedUri(req.url)) {
    res.status(400).json({ error: 'malformed_uri' });
    return;
  }
  next();
}

export function uriErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof URIError) {
    if (!res.headersSent) {
      res.status(400).json({ error: 'malformed_uri' });
    }
    return;
  }
  next(err);
}
