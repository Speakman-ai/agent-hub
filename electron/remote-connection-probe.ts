/**
 * Probe a remote Agent Hub from the main process for the renderer's
 * "Test Connection" button.
 *
 * The renderer is served from the embedded server (`http://localhost:<port>`),
 * so its fetch to a remote hub is cross-origin. Hubs only allowlist their own
 * web origins, so the browser drops the response and the user sees "Failed to
 * fetch" even though the hub is up. Node's fetch has no CORS, so the probe
 * runs here and hands the renderer the raw HTTP facts; the renderer still owns
 * the user-facing messages.
 *
 * Scope is deliberately narrow: GET `<base>/api/health`, and when the hub
 * says auth is required, GET `<base>/api/agents` with the API key. The key is
 * never sent on a redirect, so a hub that bounces requests elsewhere can't
 * leak it to another host.
 */

export interface RemoteProbeResponse {
  status: number;
  statusText: string;
}

export type RemoteProbeResult =
  | { error: 'invalid-url' | 'timeout' | 'network'; message: string }
  | {
      health: RemoteProbeResponse & { data: unknown };
      auth?: RemoteProbeResponse;
    };

export function normalizeRemoteBase(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export async function probeRemoteConnection(
  rawUrl: unknown,
  rawApiKey: unknown,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<RemoteProbeResult> {
  const base = normalizeRemoteBase(rawUrl);
  if (!base) return { error: 'invalid-url', message: 'Enter a valid http(s) server URL.' };
  const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : '';

  try {
    const healthRes = await fetchImpl(`${base}/api/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // A 200 that isn't JSON (proxy login page, SPA fallback) or a body read
    // that times out must fail the probe, not pass as an empty health object.
    const data: unknown = healthRes.ok ? await healthRes.json() : null;
    const health = { status: healthRes.status, statusText: healthRes.statusText, data };

    const authRequired = !!(data && (data as { authRequired?: unknown }).authRequired);
    if (!healthRes.ok || !authRequired || !apiKey) return { health };

    const authRes = await fetchImpl(`${base}/api/agents`, {
      headers: { Accept: 'application/json', 'X-API-Key': apiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { health, auth: { status: authRes.status, statusText: authRes.statusText } };
  } catch (err) {
    if (isTimeout(err)) return { error: 'timeout', message: 'timed out' };
    const cause = (err as { cause?: { message?: string } })?.cause?.message;
    const message = (err as Error)?.message || 'network error';
    return { error: 'network', message: cause ? `${message} (${cause})` : message };
  }
}
