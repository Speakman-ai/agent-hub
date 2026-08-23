/**
 * Which URL shape a session preview is served under, and whether that
 * shape can actually work.
 *
 * Three modes exist:
 *
 * - **direct** — no `publicUrl`. The browser is on the same machine as
 *   the dev server (local dev, Electron), so the iframe loads
 *   `http://localhost:<port>` with no Hub proxy in the path. Everything
 *   a dev server emits resolves correctly because it *is* the origin.
 *
 * - **subdomain** — `publicUrl` plus a wildcard base. Each port gets its
 *   own origin (`<port>--<sessionId>.<base>`) and renders at `/`, so a
 *   dev server's absolute asset and HMR URLs resolve correctly with no
 *   per-app configuration.
 *
 * - **path-prefix** — `publicUrl` with no wildcard base. The preview is
 *   served under `/api/sessions/<id>/preview/proxy/`, the proxy strips
 *   that mount, and the app renders at a path it doesn't know about.
 *   Relative URLs survive via an injected `<base href>`; the absolute
 *   ones every dev server emits (`/@vite/client`, `/_next/…`) do not.
 *
 * Path-prefix is the failure mode this module exists to stop. It does
 * not merely degrade — it produces a preview that loads, reports ready,
 * and then either white-screens or silently never hot-reloads, which
 * reads as "previews are broken again" rather than "this deployment is
 * missing its wildcard certificate". A misconfigured deployment should
 * say so.
 */

/** Escape hatch for operators who want the old degraded behavior. */
const ALLOW_PATH_PREFIX_ENV = 'AGENT_HUB_PREVIEW_ALLOW_PATH_PREFIX';

export type PreviewRoutingMode = 'direct' | 'subdomain' | 'path-prefix';

export interface PreviewRoutingInputs {
  /** `AGENT_HUB_PUBLIC_URL` / `config.publicUrl`. */
  publicUrl: string | null | undefined;
  /** `AGENT_HUB_PREVIEW_SUBDOMAIN_BASE` / `config.previewSubdomainBase`. */
  subdomainBase: string | null | undefined;
}

/**
 * Hostnames that are locally-resolved without a public certificate:
 * loopback, mDNS `*.local`, and common LAN suffixes. Prod public URLs
 * (`agenthub.example.com`, `hub.example.net`, …) must NOT match.
 *
 * This is not a product hostname list — operators pick their own
 * `AGENT_HUB_PUBLIC_URL` (dnsmasq, `/etc/hosts`, `*.local`, …). A
 * custom public-TLD name is handled by `AGENT_HUB_PREVIEW_LOCAL_DOCKER=1`
 * in `deriveLocalDockerPreviewSubdomainBase`, not by special-casing
 * one lab domain here.
 */
export function isLocalDockerHubHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.home') ||
    host.endsWith('.internal') ||
    host.endsWith('.localdomain')
  ) {
    return true;
  }
  return false;
}

function hostnameLooksLikeIp(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true;
  if (hostname.includes(':')) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Compose publishes nginx on `AGENT_HUB_WEB_PORT` (default 80, commonly
 * 8080). `new URL(...).hostname` drops that port, so a derived base of
 * `preview.hub.local` would make the iframe dial :80 while the Hub is
 * only on :8080. Keep any non-default port on the derived base.
 */
export function previewSubdomainPortSuffix(publicUrl: URL): string {
  const port = publicUrl.port;
  if (!port) return '';
  if (publicUrl.protocol === 'http:' && port === '80') return '';
  if (publicUrl.protocol === 'https:' && port === '443') return '';
  return `:${port}`;
}

function localDockerPreviewFlag(env: NodeJS.ProcessEnv): boolean | null {
  const raw = env.AGENT_HUB_PREVIEW_LOCAL_DOCKER;
  if (raw === undefined || raw === '') return null;
  const flag = raw.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on') return true;
  return null;
}

/** True when the Hub is published over HTTP (no wildcard cert expected). */
export function publicUrlUsesHttp(publicUrl: string | null | undefined): boolean {
  const raw = typeof publicUrl === 'string' ? publicUrl.trim() : '';
  if (!raw) return false;
  try {
    return new URL(raw).protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * When compose publishes a public URL and the operator has not set
 * `AGENT_HUB_PREVIEW_SUBDOMAIN_BASE`, derive `preview.<hub-host>` so
 * Docker Desktop / LAN Hubs get working HMR instead of the 501 path-prefix
 * block. Explicit env/config always wins.
 *
 * - Unset flag: only loopback / `*.local` / LAN suffixes (never a random
 *   public hostname, so prod URLs stay untouched).
 * - `AGENT_HUB_PREVIEW_LOCAL_DOCKER=1` (compose default): the operator's
 *   `AGENT_HUB_PUBLIC_URL` host, whatever they chose.
 * - `AGENT_HUB_PREVIEW_LOCAL_DOCKER=0`: disable derivation.
 */
export function deriveLocalDockerPreviewSubdomainBase(
  publicUrl: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const flag = localDockerPreviewFlag(env);
  if (flag === false) return null;
  const raw = typeof publicUrl === 'string' ? publicUrl.trim() : '';
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const hostname = parsed.hostname;
  if (!hostname || hostnameLooksLikeIp(hostname)) return null;
  if (flag !== true && !isLocalDockerHubHost(hostname)) return null;
  return `preview.${hostname}${previewSubdomainPortSuffix(parsed)}`;
}

export function resolvePreviewRoutingMode(inputs: PreviewRoutingInputs): PreviewRoutingMode {
  const publicUrl = typeof inputs.publicUrl === 'string' ? inputs.publicUrl.trim() : '';
  if (!publicUrl) return 'direct';
  const explicit = typeof inputs.subdomainBase === 'string' ? inputs.subdomainBase.trim() : '';
  const base = explicit || deriveLocalDockerPreviewSubdomainBase(publicUrl);
  return base ? 'subdomain' : 'path-prefix';
}

/** True when the operator has explicitly opted back into path-prefix. */
export function pathPrefixPreviewsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ALLOW_PATH_PREFIX_ENV];
  return raw === '1' || raw === 'true';
}

export const PATH_PREFIX_PREVIEW_ERROR =
  'This deployment cannot serve a working preview yet: it has a public URL but no preview ' +
  'subdomain base, so previews would be served under a path prefix. Dev servers emit ' +
  'absolute asset and HMR URLs that ignore that prefix, which produces a blank preview or ' +
  'one that never picks up your changes. Set AGENT_HUB_PREVIEW_SUBDOMAIN_BASE (and provision ' +
  'the matching wildcard certificate + DNS) — see ops/RUNBOOK-subdomain-preview-hmr.md. To ' +
  `serve the degraded path-prefix preview anyway, set ${ALLOW_PATH_PREFIX_ENV}=1.`;

/**
 * Reason a preview must not start, or null when routing is workable.
 *
 * Returned rather than thrown so the caller can surface it as a normal
 * API error with an actionable message instead of a stack trace.
 */
export function previewRoutingBlockReason(
  inputs: PreviewRoutingInputs,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (resolvePreviewRoutingMode(inputs) !== 'path-prefix') return null;
  if (pathPrefixPreviewsAllowed(env)) return null;
  return PATH_PREFIX_PREVIEW_ERROR;
}
