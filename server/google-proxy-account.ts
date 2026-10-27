/**
 * Account selection shared by the `/api/google/{calendar,gmail,sheets,drive}`
 * proxies.
 *
 * A Hub user can link several Google accounts. Every proxy call takes an
 * optional `account` query parameter holding either a linked account id or its
 * Google email (case-insensitive):
 *
 *   - omitted → the user's default account
 *   - names a linked account → that account
 *   - names nothing the user linked → 404 `google_account_not_found`. It never
 *     falls back to the default, so a call aimed at one mailbox can't read or
 *     send from another.
 *
 * Scope errors name the account they were checked against, because different
 * accounts can hold different grants.
 */
import type { Request, Response } from 'express';
import type { RouteDeps } from './types.js';
import {
  getActiveAccessToken,
  getGoogleConnectionStatus,
  type GoogleAccountSelector,
} from './google-connections-store.js';
import { resolveGoogleConnectionUserId } from './google-connection-user.js';
import { parseGoogleAccountSelector } from './google-account-selector.js';
import { z } from './openapi/registry.js';

/** Response header naming the Google account that served a proxy call. */
export const GOOGLE_ACCOUNT_HEADER = 'X-Google-Account';

export const GOOGLE_ACCOUNT_QUERY_DESCRIPTION =
  'Linked Google account to act as: its account id or email. Omit to use the default account. An account that is not linked returns 404 `google_account_not_found`.';

/** Zod field for the `account` query parameter (merge into each route's query schema). */
export const googleAccountQueryField = () =>
  z.string().trim().min(1).max(320).optional().openapi({
    description: GOOGLE_ACCOUNT_QUERY_DESCRIPTION,
    example: 'work@example.com',
  });

export const GoogleAccountQuerySchema = z.object({ account: googleAccountQueryField() });

/** The resolved caller and the Google account the call runs as. */
export interface GoogleProxyAccess {
  userId: string;
  accountId: string | null;
  email: string | null;
  /** Selector forwarded to the token store; undefined means the default account. */
  selector: GoogleAccountSelector | undefined;
}

function send(res: Response, status: number, body: Record<string, unknown>): void {
  res.status(status).json(body);
}

/**
 * Resolve the caller, check the server has Google OAuth configured, pick the
 * requested account, and check the surface scope on that account. Returns null
 * after sending the error response.
 */
export function requireGoogleProxyAccess(
  req: Request,
  res: Response,
  deps: RouteDeps,
  opts: {
    /** User-facing surface name, e.g. "Google Calendar". */
    surface: string;
    check: (scopes: string[]) => boolean;
    requiredScopes: string[];
    scopeCode: string;
  },
): GoogleProxyAccess | null {
  // An explicit `account` must be a usable selector. Only an omitted parameter
  // means "default"; a blank or repeated value must not silently become it.
  let selector: GoogleAccountSelector | undefined;
  if (req.query.account !== undefined) {
    const parsed = GoogleAccountQuerySchema.safeParse({ account: req.query.account });
    selector = parsed.success ? parseGoogleAccountSelector(parsed.data.account) : undefined;
    if (!selector) {
      send(res, 400, {
        error: 'account must be a linked Google account id or email; omit it to use the default',
        code: 'invalid_request',
      });
      return null;
    }
  }

  const uid = resolveGoogleConnectionUserId(req, deps.stmts);
  if (!uid) {
    send(res, 401, { error: 'Authentication required', code: 'authentication_required' });
    return null;
  }
  if (!deps.config.googleOAuth?.clientId || !deps.config.googleOAuth?.clientSecret) {
    send(res, 503, {
      error: 'Google OAuth is not configured on this server',
      code: 'google_oauth_not_configured',
    });
    return null;
  }

  const status = getGoogleConnectionStatus(uid, selector);
  if (!status.connected) {
    if (selector) {
      const label = selector.email ?? selector.accountId ?? '';
      send(res, 404, {
        error: `Google account ${label} is not linked. Link it under Settings → Account → Google, or omit account to use the default.`,
        code: 'google_account_not_found',
        account: label,
      });
      return null;
    }
    send(res, 401, { error: 'Google account is not connected', code: 'google_not_connected' });
    return null;
  }

  const email = status.email ?? null;
  if (!opts.check(status.grantedScopes)) {
    send(res, 403, {
      error: `${opts.surface} access has not been granted${email ? ` for ${email}` : ''}`,
      code: opts.scopeCode,
      requiredScopes: opts.requiredScopes,
      ...(email ? { account: email } : {}),
    });
    return null;
  }

  // Header values must be printable ASCII; skip an internationalized address.
  if (email && /^[\x20-\x7e]+$/.test(email)) res.setHeader(GOOGLE_ACCOUNT_HEADER, email);
  return {
    userId: uid,
    accountId: status.accountId ?? null,
    email,
    // Pin the token lookup to the account whose scopes were just checked.
    selector: selector
      ? status.accountId
        ? { accountId: status.accountId }
        : selector
      : undefined,
  };
}

/** Fresh access token for the resolved account, or null after sending the error. */
export async function resolveGoogleProxyToken(
  access: GoogleProxyAccess,
  deps: RouteDeps,
  res: Response,
  logTag: string,
): Promise<string | null> {
  const creds = deps.config.googleOAuth ?? null;
  let token: string | null;
  try {
    token = access.selector
      ? await getActiveAccessToken(access.userId, creds, { account: access.selector })
      : await getActiveAccessToken(access.userId, creds);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${logTag}] Failed to resolve token for user ${access.userId}: ${msg}`);
    send(res, 502, {
      error: 'Failed to resolve Google access token',
      code: 'google_token_resolution_failed',
    });
    return null;
  }
  if (!token) {
    send(res, 401, {
      error: access.email
        ? `Google account ${access.email} must be reconnected`
        : 'Google account must be reconnected',
      code: 'google_reconnect_required',
      ...(access.email ? { account: access.email } : {}),
    });
    return null;
  }
  return token;
}
