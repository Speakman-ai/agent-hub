/**
 * Rewrite repo-relative image srcs in a Hub-hosted README to the git-host
 * media mount so they actually load.
 *
 * A README's `![alt](docs/media/x.png)` refs are relative to the README's
 * directory. Rendered in the SPA, a browser resolves them against the app URL
 * (e.g. `https://hub/#/repo:agent-hub`) and 404s, so the image slots render
 * blank. This maps a README-relative src to
 * `${serverBase}/git-host-media/<projectId>?path=<repoPath>&branch=<branch>&token=<token>`,
 * which streams the raw blob out of the bare repo. The token comes from the
 * authenticated README endpoint and keeps project slug + path from becoming a
 * public blob lookup key.
 *
 * Absolute URLs (shields.io badges, `https://…`), protocol-relative `//…`,
 * leading-slash site-root paths, `data:` URIs, and in-page `#anchors` are left
 * untouched.
 */

import { getServerBase } from './connection';

/** Collapse `.`/`..` segments; returns null when the path escapes the root. */
function normalizeRepoPath(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null; // escapes repo root
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.length ? out.join('/') : null;
}

interface ResolveRepoImageOpts {
  projectId: string;
  branch?: string;
  /** Opaque token returned by the README endpoint for browser-loadable images. */
  mediaToken?: string;
  /** Directory of the README (root-relative), for resolving relative srcs. */
  baseDir?: string;
  /** Test seam — defaults to getServerBase(). */
  serverBase?: string;
}

export function resolveRepoImageUrl(src: any, opts: ResolveRepoImageOpts): any {
  if (src == null || typeof src !== 'string') return src;
  const trimmed = src.trim();
  if (!trimmed) return src;

  // Leave absolute URLs, scheme URIs (data:, mailto:), protocol-relative
  // `//host`, site-root `/path`, and pure `#anchors` alone.
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('#')
  ) {
    return src;
  }

  const { projectId, branch, mediaToken, baseDir = '' } = opts;
  if (!projectId) return src;

  // Drop any query/hash (e.g. GitHub's `?raw=true`) — the media mount serves
  // the raw blob directly.
  const pathPart = trimmed.split('?')[0].split('#')[0];

  const joined = `${baseDir}/${pathPart}`;
  const repoPath = normalizeRepoPath(joined);
  if (!repoPath) return src; // empty or escaped root — can't map, leave as-is

  const base = opts.serverBase !== undefined ? opts.serverBase : getServerBase();
  const prefix = base ? base.replace(/\/+$/, '') : '';
  const params = new URLSearchParams();
  params.set('path', repoPath);
  if (branch) params.set('branch', branch);
  if (mediaToken) params.set('token', mediaToken);
  return `${prefix}/git-host-media/${encodeURIComponent(projectId)}?${params.toString()}`;
}
