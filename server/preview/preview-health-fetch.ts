/**
 * Preview readiness probes from inside the Hub container.
 *
 * Vite / Angular dev servers reject requests whose `Host` is
 * `host.docker.internal` (403). Probes must target the published host port
 * but send `Host: localhost`. Node's global `fetch` (undici) does not honor
 * a manual `Host` override when the URL hostname differs — use `http.get`.
 */
import http from 'http';
import https from 'https';

/** Dev-server Host header when probing via host.docker.internal. */
export function healthProbeHostHeader(hostname: string): string | undefined {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
    return undefined;
  }
  return 'localhost';
}

/** @deprecated Use {@link probePreviewHealth} — undici ignores Host overrides. */
export function healthCheckRequestInit(healthUrl: string): RequestInit | undefined {
  let host: string;
  try {
    host = new URL(healthUrl).hostname;
  } catch {
    return undefined;
  }
  const probeHost = healthProbeHostHeader(host);
  if (!probeHost) return undefined;
  return { headers: { Host: probeHost } };
}

/** Postgres service logs drown out app boot lines in `docker compose logs`. */
const COMPOSE_DB_LOG_LINE_RE = /^db-\d+\s+\|/;

export function filterComposeLogLinesForUi(lines: string[]): string[] {
  return lines.filter((line) => !COMPOSE_DB_LOG_LINE_RE.test(line));
}

export interface PreviewHealthProbeResult {
  ok: boolean;
  statusCode?: number;
}

/** HTTP GET probe suitable for compose preview health polling. */
export function probePreviewHealth(
  healthUrl: string,
  timeoutMs = 5_000,
): Promise<PreviewHealthProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(healthUrl);
  } catch {
    return Promise.resolve({ ok: false });
  }

  const lib = parsed.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = {};
  const hostHeader = healthProbeHostHeader(parsed.hostname);
  if (hostHeader) headers.Host = hostHeader;

  const port = parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

  return new Promise((resolve) => {
    const req = lib.get(
      {
        hostname: parsed.hostname,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        const code = res.statusCode ?? 0;
        resolve({
          ok: (code >= 200 && code < 300) || (code >= 300 && code < 400),
          statusCode: code,
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.on('error', () => resolve({ ok: false }));
  });
}
