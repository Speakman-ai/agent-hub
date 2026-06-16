// Grok Build CLI auth introspection + `grok login --device-auth` banner parsing.
//
// The official xAI Grok Build CLI (https://docs.x.ai/build/cli) supports a
// device-code OAuth flow for headless / remote hosts — the same shape Agent
// Hub already drives for Codex (`codex login --device-auth`). The flow prints
// a verification URL plus a short user code; the user opens the URL on any
// device, enters the code, and the CLI caches the resulting token in
// `$HOME/.grok/auth.json` (7-day OAuth token, silently refreshed via the
// stored refresh_token).
//
// xAI does not publish the exact banner strings or the auth.json field names,
// so the matchers below are intentionally defensive: they key off the stable
// facts (auth URLs live on `x.ai` / `grok.com`; device codes are short,
// hyphenated, uppercase alphanumerics) rather than brittle literal copy. Each
// matcher has unit coverage over representative samples; widen the samples
// (not the parser) when a real CLI build surfaces a new format.
//
// This module is read-only with respect to the CLI — it never writes auth.json.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { stripAnsi } from './ansi-strip.js';
import type { EngineAuthUiStatus } from './cursor-auth-parse.js';

/**
 * True when `hostname` is the `x.ai` or `grok.com` apex or one of their
 * subdomains. Compares parsed URL hostnames only — never substrings — so a
 * look-alike like `x.ai.evil.example` or `grok.com.evil.example` is rejected.
 */
function isXaiAuthHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'x.ai' || h.endsWith('.x.ai') || h === 'grok.com' || h.endsWith('.grok.com');
}

/**
 * Extract the device-authorization URL from `grok login --device-auth`
 * output. xAI auth flows live on the `x.ai` / `grok.com` domains (issuer
 * `auth.x.ai`). We pull every https candidate out of the banner, parse each
 * with `new URL(...)`, and return the first whose *hostname* is a real xAI
 * host. Validating the parsed hostname (not a substring match) means a
 * compromised/misconfigured binary emitting `https://x.ai.evil.example/...`
 * cannot smuggle an attacker origin through to the browser. Returns null when
 * no valid URL is present yet (the caller keeps buffering).
 */
export function extractGrokDeviceUrl(text: string): string | null {
  const plain = stripAnsi(text);
  const candidates = plain.match(/https:\/\/[^\s)\]]+/gi);
  if (!candidates) return null;
  for (const raw of candidates) {
    // Trailing prose punctuation (".", ",", ";", ":") commonly abuts a URL.
    const cleaned = raw.replace(/[.,;:]+$/, '');
    let url: URL;
    try {
      url = new URL(cleaned);
    } catch {
      continue;
    }
    if (url.protocol === 'https:' && isXaiAuthHost(url.hostname)) {
      return cleaned;
    }
  }
  return null;
}

/**
 * Extract the short user/device code (e.g. `ABCD-EFGH`) the user types into
 * the verification page. Prefer a labeled match ("enter ... code: XXXX-YYYY")
 * and fall back to a loose hyphenated uppercase-alnum token so we still
 * surface the code if xAI tweaks the surrounding copy.
 */
export function extractGrokDeviceUserCode(text: string): string | null {
  const plain = stripAnsi(text);
  const labeled = plain.match(/code[^\n]*?\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/i);
  if (labeled) return labeled[1].toUpperCase();
  const loose = plain.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/);
  return loose ? loose[1].toUpperCase() : null;
}

export type GrokAuthMode = 'oauth' | 'apikey' | 'unknown';

export interface GrokAuthInfo {
  mode: GrokAuthMode;
  /** Absolute path inspected. Useful for log lines when something is off. */
  path: string;
  /** True if auth.json existed and parsed as JSON. */
  present: boolean;
}

/**
 * Read `<grokHome>/auth.json` and report the active auth mode. Never throws —
 * missing / unreadable / malformed files collapse to `{ mode: 'unknown',
 * present: false }`.
 *
 * OAuth material (a non-empty `access_token` / `refresh_token` / `id_token`,
 * either top-level or nested under a `tokens` object) is reported as `oauth`;
 * a persisted key (`api_key` / `apiKey` / `XAI_API_KEY`) as `apikey`. A
 * placeholder shell like `{ "tokens": {} }` carries no usable token, so it is
 * reported `unknown`/present rather than `oauth` — otherwise a stale cache
 * would shadow the working API-key path. We treat `oauth` as authoritative
 * when both shapes appear, because a `grok login` cached token is what the
 * CLI prefers over the `XAI_API_KEY` env var.
 */
export function detectGrokAuthMode(grokHome?: string): GrokAuthInfo {
  const root = grokHome ?? join(homedir(), '.grok');
  const path = join(root, 'auth.json');
  if (!existsSync(path)) {
    return { mode: 'unknown', path, present: false };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hasOAuth =
      hasNonEmpty(parsed.access_token) ||
      hasNonEmpty(parsed.refresh_token) ||
      hasNonEmpty(parsed.id_token) ||
      hasNonEmptyNestedToken(parsed.tokens) ||
      hasGrokOidcIssuerEntries(parsed);
    if (hasOAuth) return { mode: 'oauth', path, present: true };
    const hasApiKey =
      hasNonEmpty(parsed.api_key) || hasNonEmpty(parsed.apiKey) || hasNonEmpty(parsed.XAI_API_KEY);
    if (hasApiKey) return { mode: 'apikey', path, present: true };
    return { mode: 'unknown', path, present: true };
  } catch {
    return { mode: 'unknown', path, present: false };
  }
}

function hasNonEmpty(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v != null && v !== false;
}

/**
 * True when a `tokens` container actually holds a non-empty token string.
 * An empty / placeholder object (`{}`) or a non-object is NOT a usable OAuth
 * identity, so it must not flip the cache to `oauth` mode.
 */
function hasNonEmptyNestedToken(tokens: unknown): boolean {
  if (tokens == null || typeof tokens !== 'object') return false;
  const t = tokens as Record<string, unknown>;
  return hasNonEmpty(t.access_token) || hasNonEmpty(t.refresh_token) || hasNonEmpty(t.id_token);
}

/**
 * Current Grok Build CLI (2026) stores OIDC sessions under issuer-keyed entries
 * like `"https://auth.x.ai::<client_id>": { key, refresh_token, auth_mode, … }`.
 * The access JWT lives in `key`, not top-level `access_token`.
 */
function hasGrokOidcIssuerEntries(parsed: Record<string, unknown>): boolean {
  for (const value of Object.values(parsed)) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const hasAccess =
      hasNonEmpty(entry.key) || hasNonEmpty(entry.access_token) || hasNonEmpty(entry.id_token);
    const hasRefresh = hasNonEmpty(entry.refresh_token);
    if (hasAccess && hasRefresh) return true;
    if (entry.auth_mode === 'oidc' && (hasAccess || hasRefresh)) return true;
  }
  return false;
}

/**
 * Collapse the inputs the status route knows about into the shared
 * three-state UI enum (mirrors `computeCodexUiStatus`).
 */
export function computeGrokUiStatus(p: {
  binaryPresent: boolean;
  loginInProgress: boolean;
  /** A pasted xAI API key is configured (per-user or host fallback). */
  apiKeyConfigured: boolean;
  /** `grok login` OAuth tokens present in `$HOME/.grok/auth.json`. */
  oauthFromFile: boolean;
}): EngineAuthUiStatus {
  if (!p.binaryPresent) return 'missing';
  if (p.loginInProgress) return 'pending';
  if (p.apiKeyConfigured || p.oauthFromFile) return 'authenticated';
  return 'missing';
}
