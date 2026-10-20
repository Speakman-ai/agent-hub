// Detects a Cursor CLI OAuth login whose refresh token has already expired.
//
// `cursor-agent status` only checks that tokens are *present*: with both the
// access and refresh JWTs past their `exp` it still prints
// `isAuthenticated: true` ("Logged in (unable to fetch user details)"), so the
// Hub's spawn guard, the pre-spawn warm-up, and Account settings all report
// Cursor as signed in. The spawn then dies with "Authentication required.
// Please run 'agent login' first". A dead refresh token cannot be renewed, so
// the only fix is a fresh `agent login`; reading `exp` lets us say so up front.

import { readFileSync } from 'fs';
import path from 'path';

/** Locations the Cursor CLI writes its OAuth cache to, relative to HOME. */
const CURSOR_AUTH_FILES = [
  path.join('.config', 'cursor', 'auth.json'),
  path.join('.cursor', 'auth.json'),
];

function jwtExpMs(token: unknown): number | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/**
 * Expiry (ms since epoch) of the refresh token in `<home>`'s Cursor OAuth
 * cache when every cache file found holds a refresh token that has already
 * expired. Returns `null` when no cache exists, any cache is still renewable,
 * or the token shape is unknown — callers then fall back to the CLI probe.
 */
export function cursorOAuthExpiredAt(
  home: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!home?.trim()) return null;
  let latestExpired: number | null = null;
  for (const rel of CURSOR_AUTH_FILES) {
    let raw: string;
    try {
      raw = readFileSync(path.join(home, rel), 'utf8');
    } catch {
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
    const parsed = decoded as { refreshToken?: unknown; accessToken?: unknown };
    const refreshExp = jwtExpMs(parsed.refreshToken);
    if (refreshExp === null || refreshExp > nowMs) return null;
    const accessExp = jwtExpMs(parsed.accessToken);
    if (accessExp !== null && accessExp > nowMs) return null;
    latestExpired = Math.max(latestExpired ?? 0, refreshExp);
  }
  return latestExpired;
}

export function cursorOAuthExpiredMessage(expiredAtMs: number): string {
  const day = new Date(expiredAtMs).toISOString().slice(0, 10);
  return `Your Cursor login expired on ${day}. Sign in to Cursor again under Account settings.`;
}
