/**
 * IntegrationProvider — abstraction over a managed-OAuth proxy
 * (Nango Cloud, Nango Self-Hosted, future native impls, etc.).
 *
 * Every concrete adapter implements the same four operations so call
 * sites (route handlers, spawn-time env injection, settings UI) never
 * branch on which provider is wired up. Provider selection is config-
 * driven (`integration_providers` row) and resolved through
 * `getIntegrationProvider()` below.
 *
 * See the "Integration Provider — Nango vs Maton ADR" wiki page for the
 * design rationale and the two-tier (operator / end-user) split.
 *
 * `end_user_id` contract
 * ----------------------
 * Hub-Shared mode lets multiple Hub installs share the same Nango
 * project. To keep tenants isolated, every connection is scoped by a
 * composite identifier:
 *
 *     end_user_id = `${hubInstanceId}:${userId}`
 *
 *  - `hubInstanceId` is a stable UUID per Hub install
 *    (`hub_instance` singleton in `orgs.db`).
 *  - `userId` is the Hub user UUID.
 *
 *  `listConnections` MUST filter by the `${hubInstanceId}:` prefix so a
 *  bug in upstream Nango filtering (or a stale `end_user_id` index)
 *  cannot leak another tenant's connections back to the caller. This
 *  belt-and-braces filter is enforced in the adapter, not in routes.
 */

import { getIntegrationProviderConfig } from '../integration-provider-runtime.js';
import { NangoAdapter } from './nango-adapter.js';

/** Per-user OAuth connection as surfaced to Hub callers. */
export interface UserConnection {
  /** Nango connection id (opaque). Unique per (provider, end_user_id, app). */
  connectionId: string;
  /** Provider config key (e.g. `slack`, `google-mail`). */
  app: string;
  /** ISO timestamp Nango recorded the connection at. */
  createdAt: string;
  /** End-user id Nango stored — `${hubInstanceId}:${userId}` in Shared mode. */
  endUserId: string;
  /** Free-form metadata Nango carries with the connection (or null). */
  metadata: Record<string, unknown> | null;
}

/** Options for an outbound proxied API call. */
export interface ProxyOpts {
  /** HTTP method. Defaults to GET. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON-serialisable request body. */
  body?: unknown;
  /** Extra headers to forward to the upstream API (Nango will prefix). */
  headers?: Record<string, string>;
  /** URL query params. */
  query?: Record<string, string | number | boolean | undefined>;
}

export interface IntegrationProvider {
  /**
   * Create a Connect Session and return a hosted auth URL the user can
   * open to complete OAuth. `endUserId` is computed from
   * `(hubInstanceId, userId)` and forwarded so Nango can scope the
   * resulting connection to this tenant.
   */
  createConnection(params: {
    hubInstanceId: string;
    userId: string;
    app: string;
  }): Promise<{ authUrl: string; connectionId: string; endUserId: string }>;

  /** List connections for a single (hubInstanceId, userId) pair. */
  listConnections(params: { hubInstanceId: string; userId: string }): Promise<UserConnection[]>;

  /** Make an authenticated upstream API call through the provider proxy. */
  proxyCall(params: {
    connectionId: string;
    app: string;
    path: string;
    opts: ProxyOpts;
  }): Promise<unknown>;

  /** Tear down a connection upstream. Idempotent. */
  deleteConnection(connectionId: string): Promise<void>;
}

/**
 * Error thrown by adapters for any non-2xx upstream response. Routes
 * can inspect `status` to decide whether to surface a 4xx or 5xx to the
 * caller without re-parsing body text.
 */
export class IntegrationProviderError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'IntegrationProviderError';
    this.status = status;
    this.body = body;
  }
}

// ── Singleton accessor ───────────────────────────────────────────────
//
// The provider config is read from `integration_providers` (orgs.db) +
// process env + config.json fallback. We cache the resolved adapter so
// the per-call cost is just `Map.get`. The cache invalidates whenever
// the resolved tuple of (provider, baseUrl, secretKey, mode) changes —
// a Settings UI write rotates secrets, and we want the next call to
// pick that up without a server restart.

interface CacheKey {
  provider: string;
  baseUrl: string;
  secretKey: string;
  mode: string;
}

let cachedAdapter: IntegrationProvider | null = null;
let cachedKey: CacheKey | null = null;

function keysEqual(a: CacheKey, b: CacheKey): boolean {
  return (
    a.provider === b.provider &&
    a.baseUrl === b.baseUrl &&
    a.secretKey === b.secretKey &&
    a.mode === b.mode
  );
}

/**
 * Resolve and return the active integration provider. Throws if the
 * runtime resolver reports an unconfigured / disabled state — callers
 * should normally check `isIntegrationProviderReady()` first and render
 * a "configure Nango" notice instead of catching here.
 */
export function getIntegrationProvider(): IntegrationProvider {
  const r = getIntegrationProviderConfig();
  if (!r.ok) {
    throw new IntegrationProviderError(
      `Integration provider not configured: ${r.reason}`,
      503,
      JSON.stringify({ reason: r.reason, mode: r.mode, provider: r.provider }),
    );
  }
  const key: CacheKey = {
    provider: r.provider,
    baseUrl: r.baseUrl,
    secretKey: r.secretKey,
    mode: r.mode,
  };
  if (cachedAdapter && cachedKey && keysEqual(cachedKey, key)) {
    return cachedAdapter;
  }
  // Both nango-cloud and nango-selfhosted are served by NangoAdapter —
  // they only differ in `baseUrl`, which the adapter takes as input.
  const adapter = new NangoAdapter({ baseUrl: r.baseUrl, secretKey: r.secretKey });
  cachedAdapter = adapter;
  cachedKey = key;
  return adapter;
}

/** Test-only — clear the cached singleton between cases. */
export function __resetIntegrationProviderCacheForTests(): void {
  cachedAdapter = null;
  cachedKey = null;
}
