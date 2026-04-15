import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';
import config from './config.js';

const PUBLIC_PATHS: readonly string[] = [
  '/api/health',
  '/api/github-app/callback',
  '/api/github-app/setup-complete',
  '/api/github-app/register',
];

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = config.apiKey;

  if (!apiKey) {
    next();
    return;
  }

  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  if (PUBLIC_PATHS.includes(req.path)) {
    next();
    return;
  }

  const provided =
    (req.headers['x-api-key'] as string | undefined) || (req.query.apiKey as string | undefined);

  if (!provided) {
    res
      .status(401)
      .json({ error: 'API key required. Set X-API-Key header or ?apiKey= query param.' });
    return;
  }

  if (provided !== apiKey) {
    res.status(403).json({ error: 'Invalid API key.' });
    return;
  }

  next();
}

export function authenticateWs(request: IncomingMessage): boolean {
  const apiKey = config.apiKey;
  if (!apiKey) return true;

  const url = new URL(request.url!, `http://${request.headers.host}`);
  const provided = url.searchParams.get('apiKey');
  return provided === apiKey;
}
