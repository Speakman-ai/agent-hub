/**
 * Preview-URL auth — Express route factory (W2).
 *
 * Wires three routes onto a single router:
 *
 *   GET  /preview/auth/login
 *     Starts an OAuth flow. Mints a CSRF state, sets it in a signed cookie,
 *     and 302s to GitHub. Usually reached via the middleware redirect when
 *     a reviewer hits `pr-N.preview.example.com/...` without a session.
 *
 *   GET  /preview/auth/callback
 *     GitHub OAuth redirect target. Verifies the state cookie matches the
 *     `state` query param, exchanges the code for a user token, checks org
 *     membership, and (on success) sets the preview session cookie + 302s
 *     to the original URL carried in the state cookie.
 *
 *   POST /api/preview/magic-links
 *     Admin endpoint — issues a new magic link for a PR. The response
 *     includes the plaintext token exactly once. Auth for this endpoint
 *     piggy-backs on the caller's existing Agent-Hub auth (the route is
 *     mounted behind the standard `authMiddleware`).
 *
 *   POST /api/preview/magic-links/:token/revoke
 *     Admin endpoint — revokes a magic link by the plaintext token the
 *     operator still holds (e.g. from the UI that just displayed it).
 *     Idempotent (revoking an already-revoked link returns `{revoked:true}`
 *     with no side effects).
 */

import express, { Router, Request, Response } from 'express';
import {
  buildAuthorizeUrl,
  buildPostAuthRedirect,
  completeOAuthFlow,
  decodeStatePayload,
  encodeStatePayload,
  generateOpaqueToken,
  issueMagicLink,
  MAGIC_LINK_QUERY_PARAM,
  parseCookies,
  PREVIEW_SESSION_COOKIE,
  PREVIEW_STATE_COOKIE,
  revokeMagicLink,
  serializeCookie,
  signSessionCookie,
  verifySessionCookie,
  type PreviewAuthDeps,
} from './preview-auth.js';

const MAX_NEXT_URL_LENGTH = 2048;
const MAX_REDIRECT_COOKIE_AGE_SECONDS = 600;

function safeNextUrl(raw: string | undefined): string {
  // Only accept same-origin relative paths — never an absolute URL the
  // attacker could bounce us to after login. Reject anything that
  // doesn't look like a root-relative path.
  if (!raw) return '/';
  if (raw.length > MAX_NEXT_URL_LENGTH) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/'; // protocol-relative
  return raw;
}

export interface PreviewAuthRoutesDeps extends PreviewAuthDeps {
  /**
   * Predicate that gates the admin magic-link issuance routes. Returns
   * a string (the actor identity stored as `created_by`) when allowed,
   * null when unauthorized. Usually derives identity from the JWT on
   * `req` set by the main auth middleware.
   */
  adminAuth: (req: Request) => string | null;
}

export function createPreviewAuthRoutes(deps: PreviewAuthRoutesDeps): Router {
  const router = Router();

  // ── GET /preview/auth/login ──
  router.get('/preview/auth/login', (req: Request, res: Response) => {
    const rng = deps.randomBytes ?? undefined;
    const state = generateOpaqueToken(rng);
    const nextUrl = safeNextUrl(typeof req.query.next === 'string' ? req.query.next : undefined);
    // `host` comes from `?nextHost=` when the middleware sent the user
    // here with an absolute destination in mind, otherwise from the
    // request's own Host header. Either way the value is bounded by
    // the `cookieDomain` suffix check in buildPostAuthRedirect so a
    // forged value can only redirect within the wildcard.
    const nextHost =
      typeof req.query.nextHost === 'string' && req.query.nextHost
        ? req.query.nextHost
        : (req.headers.host ?? '');
    const payload = encodeStatePayload({ state, host: nextHost, nextUrl });
    const signed = signSessionCookie(payload, deps.config.sessionSecret);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(PREVIEW_STATE_COOKIE, signed, {
        maxAgeSeconds: MAX_REDIRECT_COOKIE_AGE_SECONDS,
        httpOnly: true,
        secure: deps.config.secureCookies ?? true,
        sameSite: 'Lax',
        domain: deps.config.cookieDomain,
      }),
    );
    res.redirect(302, buildAuthorizeUrl(deps, { state }));
  });

  // ── GET /preview/auth/callback ──
  router.get('/preview/auth/callback', async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const incomingState = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !incomingState) {
      res.status(400).type('text/plain').send('Missing code/state');
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const stateCookie = cookies[PREVIEW_STATE_COOKIE];
    if (!stateCookie) {
      res.status(400).type('text/plain').send('Missing state cookie (is the flow expired?)');
      return;
    }
    const unsigned = verifySessionCookie(stateCookie, deps.config.sessionSecret);
    if (!unsigned) {
      res.status(400).type('text/plain').send('Invalid state cookie signature');
      return;
    }
    const decoded = decodeStatePayload(unsigned);
    if (decoded.state !== incomingState) {
      res.status(400).type('text/plain').send('State mismatch');
      return;
    }

    const flow = await completeOAuthFlow(deps, { code });
    if (!flow.ok) {
      if (flow.reason === 'not_member') {
        res
          .status(403)
          .type('text/plain')
          .send(
            `Access denied: you are not a member of the ${deps.config.githubOrg} GitHub org.\n` +
              `If you are an external reviewer, ask the PR author for a magic link.`,
          );
        return;
      }
      res
        .status(502)
        .type('text/plain')
        .send(`OAuth failed: ${flow.detail ?? 'unknown'}`);
      return;
    }

    // Clear the state cookie and set the session cookie. Both are
    // emitted with the same `Domain` so the session cookie is visible
    // across the wildcard — the middleware on `pr-N.<domain>` will see
    // it on the next request.
    res.setHeader('Set-Cookie', [
      // Kill the state cookie — it was one-shot.
      serializeCookie(PREVIEW_STATE_COOKIE, '', {
        maxAgeSeconds: 0,
        httpOnly: true,
        secure: deps.config.secureCookies ?? true,
        sameSite: 'Lax',
        domain: deps.config.cookieDomain,
      }),
      serializeCookie(PREVIEW_SESSION_COOKIE, flow.session.cookieValue, {
        maxAgeSeconds: flow.session.maxAgeSeconds,
        httpOnly: true,
        secure: deps.config.secureCookies ?? true,
        sameSite: 'Lax',
        domain: deps.config.cookieDomain,
      }),
    ]);
    // Build an absolute redirect back to the originating PR host — the
    // callback and middleware live on different subdomains so a bare
    // `/path` would leave the browser on the callback host.
    const absoluteNext = buildPostAuthRedirect({
      host: decoded.host,
      nextUrl: safeNextUrl(decoded.nextUrl || '/'),
      cookieDomain: deps.config.cookieDomain ?? null,
      secure: deps.config.secureCookies ?? true,
    });
    res.redirect(302, absoluteNext);
  });

  // ── POST /api/preview/magic-links ──
  router.post(
    '/api/preview/magic-links',
    express.json({ limit: '16kb' }),
    (req: Request, res: Response) => {
      const actor = deps.adminAuth(req);
      if (!actor) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const body = (req.body ?? {}) as {
        prNumber?: unknown;
        ttlSeconds?: unknown;
      };
      const prNumber = Number(body.prNumber);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        res.status(400).json({ error: 'prNumber must be a positive integer' });
        return;
      }
      let ttl: number | undefined;
      if (body.ttlSeconds !== undefined) {
        ttl = Number(body.ttlSeconds);
        if (!Number.isFinite(ttl) || ttl <= 0) {
          res.status(400).json({ error: 'ttlSeconds must be positive' });
          return;
        }
      }
      try {
        const issued = issueMagicLink(deps, {
          prNumber,
          createdBy: actor,
          ttlSeconds: ttl,
        });
        // Preserve the scheme from baseUrl so dev-over-HTTP (localhost)
        // produces a URL the browser can actually resolve. The previous
        // hard-coded `https://` broke `http://localhost:3051` → the
        // response URL had to be rewritten by hand during dev.
        const baseNoTrailingSlash = deps.config.baseUrl.replace(/\/+$/, '');
        const schemeMatch = /^(https?:\/\/)(.+)$/.exec(baseNoTrailingSlash);
        const prUrl = schemeMatch
          ? `${schemeMatch[1]}pr-${prNumber}.${schemeMatch[2]}`
          : `https://pr-${prNumber}.${baseNoTrailingSlash}`;
        const url = `${prUrl}/?${MAGIC_LINK_QUERY_PARAM}=${encodeURIComponent(issued.token)}`;
        res.status(201).json({
          token: issued.token,
          url,
          prNumber: issued.prNumber,
          expiresAt: issued.expiresAt,
          createdBy: issued.createdBy,
        });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );

  // ── POST /api/preview/magic-links/:token/revoke ──
  router.post('/api/preview/magic-links/:token/revoke', (req: Request, res: Response) => {
    const actor = deps.adminAuth(req);
    if (!actor) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const tokenParam = req.params.token;
    const token = typeof tokenParam === 'string' ? tokenParam : '';
    if (!token) {
      res.status(400).json({ error: 'token required' });
      return;
    }
    const ok = revokeMagicLink(deps, token);
    res.json({ revoked: ok });
  });

  return router;
}
