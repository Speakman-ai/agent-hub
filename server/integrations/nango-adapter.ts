/**
 * NangoAdapter — IntegrationProvider implementation backed by Nango's
 * managed-OAuth API (https://api.nango.dev by default; overridable for
 * self-hosted deployments).
 *
 * API surfaces touched:
 *   - `POST /connect/sessions`  → hosted auth URL (`connect_link`)
 *     https://docs.nango.dev/reference/api/connect/sessions/create
 *   - `GET  /connection`        → list connections (deprecated alias is
 *     `/connections`; `/connection` is the current shape)
 *   - `<METHOD> /proxy/{path}`  → authenticated upstream call
 *   - `DELETE /connection/{id}` → tear-down
 *
 * `end_user.id` and Nango deprecation
 * -----------------------------------
 * Nango is migrating from the top-level `end_user` object to a
 * `tags`-based filter. As of 2026-05-04 the `end_user` field is still
 * accepted on Connect Session creation and on connection list responses;
 * it is what the ADR pins for the Hub-Shared `${hubInstanceId}:${userId}`
 * scoping. We forward `end_user.id` AND mirror the value into `tags`
 * (`end_user_id` key) so both the legacy and the new filter paths work
 * during the transition window. List calls re-filter client-side on the
 * `${hubInstanceId}:` prefix as a defence-in-depth pass.
 */

import {
  IntegrationProviderError,
  type IntegrationProvider,
  type ProxyOpts,
  type UserConnection,
} from './provider.js';

const DEFAULT_BASE_URL = 'https://api.nango.dev';

export interface NangoAdapterConfig {
  /** Base URL — `https://api.nango.dev` for cloud, custom for self-hosted. */
  baseUrl?: string;
  /** Nango environment secret key (Bearer token). */
  secretKey: string;
  /**
   * Optional fetch override. Tests inject a mock; production leaves it
   * undefined so the global `fetch` is used.
   */
  fetchImpl?: typeof fetch;
}

interface NangoConnectSessionResponse {
  data?: {
    token?: string;
    connect_link?: string;
    expires_at?: string;
  };
}

interface NangoConnectionRow {
  id?: number;
  connection_id: string;
  provider_config_key: string;
  created?: string;
  created_at?: string;
  metadata?: Record<string, unknown> | null;
  end_user?: { id?: string } | null;
  tags?: Record<string, string> | null;
}

interface NangoConnectionListResponse {
  connections?: NangoConnectionRow[];
}

function buildEndUserId(hubInstanceId: string, userId: string): string {
  if (!hubInstanceId) {
    throw new Error('NangoAdapter: hubInstanceId is required');
  }
  if (!userId) {
    throw new Error('NangoAdapter: userId is required');
  }
  return `${hubInstanceId}:${userId}`;
}

export class NangoAdapter implements IntegrationProvider {
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: NangoAdapterConfig) {
    this.baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.secretKey = cfg.secretKey;
    // Capture global fetch lazily so tests that swap `globalThis.fetch`
    // after construction still hit the swap.
    const injected = cfg.fetchImpl;
    this.fetchImpl = injected
      ? injected
      : (((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch);
  }

  // ── createConnection ─────────────────────────────────────────────
  async createConnection(params: {
    hubInstanceId: string;
    userId: string;
    app: string;
  }): Promise<{ authUrl: string; connectionId: string; endUserId: string }> {
    const endUserId = buildEndUserId(params.hubInstanceId, params.userId);
    const url = `${this.baseUrl}/connect/sessions`;

    const body = {
      // Pin to the requested integration so the hosted UI can't deep-link
      // a different OAuth app.
      allowed_integrations: [params.app],
      // Legacy field — Nango still accepts this and stores it on the
      // resulting connection. We rely on it for `listConnections`.
      end_user: { id: endUserId },
      // Forward-compat: the same value as a tag so the new tag-based
      // filter sees it too.
      tags: { end_user_id: endUserId },
    };

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new IntegrationProviderError(
        `Nango createConnection failed (${res.status})`,
        res.status,
        text,
      );
    }

    let parsed: NangoConnectSessionResponse;
    try {
      parsed = text ? (JSON.parse(text) as NangoConnectSessionResponse) : {};
    } catch {
      throw new IntegrationProviderError(
        'Nango createConnection: malformed JSON response',
        500,
        text,
      );
    }

    const data = parsed.data ?? {};
    const authUrl = data.connect_link ?? '';
    const token = data.token ?? '';
    if (!authUrl) {
      throw new IntegrationProviderError(
        'Nango createConnection: missing connect_link in response',
        500,
        text,
      );
    }

    // The connection_id isn't minted until the user finishes OAuth; the
    // session token is the stable handle until then. Surface it as the
    // `connectionId` so callers can persist a placeholder row keyed on
    // it and reconcile via the webhook.
    return { authUrl, connectionId: token, endUserId };
  }

  // ── listConnections ──────────────────────────────────────────────
  async listConnections(params: {
    hubInstanceId: string;
    userId: string;
  }): Promise<UserConnection[]> {
    const endUserId = buildEndUserId(params.hubInstanceId, params.userId);
    const tenantPrefix = `${params.hubInstanceId}:`;

    // Forward the same filter to Nango (best-effort — the `endUserId`
    // query param is deprecated, the `tags` deepObject form is the new
    // shape). We also re-filter client-side on the FULL endUserId
    // regardless: a stale Nango index or a deprecated-field removal must
    // not leak another (tenant, user) pair's connections through. The
    // exact-match filter trivially satisfies the ADR's tenant-prefix
    // safety property.
    const url = new URL(`${this.baseUrl}/connection`);
    url.searchParams.set('endUserId', endUserId);
    url.searchParams.set('tags[end_user_id]', endUserId);

    const res = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });

    const text = await res.text();
    if (!res.ok) {
      throw new IntegrationProviderError(
        `Nango listConnections failed (${res.status})`,
        res.status,
        text,
      );
    }

    let parsed: NangoConnectionListResponse;
    try {
      parsed = text ? (JSON.parse(text) as NangoConnectionListResponse) : {};
    } catch {
      throw new IntegrationProviderError(
        'Nango listConnections: malformed JSON response',
        500,
        text,
      );
    }

    const rows = Array.isArray(parsed.connections) ? parsed.connections : [];
    const out: UserConnection[] = [];
    for (const row of rows) {
      // Resolve end_user_id preferring the stored object, falling back
      // to the tag mirror, falling back to "unknown" (in which case the
      // belt-and-braces prefix check below drops the row).
      const rowEndUserId =
        row.end_user?.id ??
        (row.tags && typeof row.tags.end_user_id === 'string' ? row.tags.end_user_id : '') ??
        '';
      // Belt: exact (tenant, user) match. Braces: confirm the tenant
      // prefix as well so a future malformed endUserId can't slip past
      // an exact-match comparison through some unicode-equivalence edge.
      if (rowEndUserId !== endUserId) continue;
      if (!rowEndUserId.startsWith(tenantPrefix)) continue;
      out.push({
        connectionId: row.connection_id,
        app: row.provider_config_key,
        createdAt: row.created ?? row.created_at ?? '',
        endUserId: rowEndUserId,
        metadata: (row.metadata ?? null) as Record<string, unknown> | null,
      });
    }
    return out;
  }

  // ── proxyCall ────────────────────────────────────────────────────
  async proxyCall(params: {
    connectionId: string;
    app: string;
    path: string;
    opts: ProxyOpts;
  }): Promise<unknown> {
    const { connectionId, app, path, opts } = params;
    const method = opts.method ?? 'GET';

    // `path` may be either a relative path ("users.list") or absolute
    // ("/users.list"); normalise.
    const normalisedPath = path.startsWith('/') ? path.slice(1) : path;
    const url = new URL(`${this.baseUrl}/proxy/${normalisedPath}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Connection-Id': connectionId,
      'Provider-Config-Key': app,
      ...(opts.headers ?? {}),
    };

    let bodyInit: BodyInit | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      bodyInit = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }

    const res = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: bodyInit,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new IntegrationProviderError(
        `Nango proxy ${method} ${path} failed (${res.status})`,
        res.status,
        text,
      );
    }

    if (!text) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      try {
        return JSON.parse(text);
      } catch {
        // Fall through to raw text rather than throwing — some upstream
        // APIs lie about content-type.
      }
    }
    return text;
  }

  // ── deleteConnection ─────────────────────────────────────────────
  async deleteConnection(connectionId: string): Promise<void> {
    if (!connectionId) {
      throw new Error('NangoAdapter.deleteConnection: connectionId is required');
    }
    const url = `${this.baseUrl}/connection/${encodeURIComponent(connectionId)}`;
    const res = await this.fetchImpl(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    // 204 = no content (the documented success); 404 = already gone (idempotent success).
    if (res.status === 204 || res.status === 404) return;
    const text = await res.text();
    throw new IntegrationProviderError(
      `Nango deleteConnection failed (${res.status})`,
      res.status,
      text,
    );
  }
}
