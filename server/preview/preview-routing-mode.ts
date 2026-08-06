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

export function resolvePreviewRoutingMode(inputs: PreviewRoutingInputs): PreviewRoutingMode {
  const publicUrl = typeof inputs.publicUrl === 'string' ? inputs.publicUrl.trim() : '';
  if (!publicUrl) return 'direct';
  const base = typeof inputs.subdomainBase === 'string' ? inputs.subdomainBase.trim() : '';
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
