/**
 * Is a git remote URL this Hub's hosted repo for a project?
 *
 * A worktree can reach the hosted repo two ways: the bare repo's local path,
 * or the Hub's smart-HTTP endpoint at `<hub base>/git/<projectId>.git`. The
 * HTTP form only counts when the origin is one this Hub answers on (the spawn
 * base, `publicUrl`, or loopback on the bound port). A matching path on some
 * other host is a different repository.
 */
import path from 'path';
import config, {
  normalizedHttpSpawnBaseForAgentHub,
  resolveAgentHubApiBaseForSpawn,
} from '../config.js';
import { getActualPort } from '../server-port.js';
import { gitHostRepoPath } from './repo-store.js';

/** Base URLs (scheme://host[:port][/prefix], no trailing slash) this Hub serves git on. */
export function hubGitBaseUrls(): string[] {
  const bases = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const base = normalizedHttpSpawnBaseForAgentHub(raw);
    if (base) bases.add(base);
  };
  add(resolveAgentHubApiBaseForSpawn(config));
  add(config.publicUrl);
  const port = getActualPort();
  add(`http://127.0.0.1:${port}`);
  add(`http://localhost:${port}`);
  return [...bases];
}

function httpMatches(url: URL, base: string, projectId: string): boolean {
  let b: URL;
  try {
    b = new URL(base);
  } catch {
    return false;
  }
  if (url.search || url.hash) return false;
  const prefix = b.pathname.replace(/\/+$/, '');
  return url.origin === b.origin && url.pathname === `${prefix}/git/${projectId}.git`;
}

export function isHostedRepoUrl(
  raw: string,
  projectId: string,
  opts: { barePath?: string; baseUrls?: string[] } = {},
): boolean {
  const value = raw.trim();
  if (!value) return false;
  const bare = path.resolve(opts.barePath ?? gitHostRepoPath(projectId));

  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (!url || url.protocol.length <= 2) {
    // A plain path (a one-letter "protocol" is a Windows drive letter).
    return path.isAbsolute(value) && path.resolve(value) === bare;
  }
  if (url.protocol === 'file:') {
    if (url.host) return false;
    return path.resolve(decodeURIComponent(url.pathname)) === bare;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return (opts.baseUrls ?? hubGitBaseUrls()).some((base) => httpMatches(url!, base, projectId));
}
