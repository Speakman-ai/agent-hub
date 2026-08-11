const GITHUB_PULL_IN_TITLE_RE = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

/**
 * Where the project's PRs live. Hub-hosted projects (`gitHost: 'agenthub'`)
 * keep a `githubRepo` for the one-way mirror, so the repo slug alone cannot
 * decide the host — PR #N on such a project is a native Hub PR, and a
 * `github.com/<repo>/pull/N` link points at an unrelated (or missing) PR.
 */
export type SessionTitlePrHost = {
  gitHost?: string | null;
  projectId?: string | null;
};

export function inferPrUrlFromSessionTitle(
  sessionName: string | null | undefined,
  githubRepo: string | null | undefined,
  host?: SessionTitlePrHost | null,
): string | null {
  if (sessionName == null || typeof sessionName !== 'string') return null;
  const name = sessionName.trim();
  if (!name) return null;

  // An explicit github.com URL in the title names its host outright.
  const urlHit = name.match(GITHUB_PULL_IN_TITLE_RE);
  if (urlHit) {
    return `https://github.com/${urlHit[1]}/${urlHit[2]}/pull/${urlHit[3]}`;
  }

  const resolve = name.match(/^\[Resolve PR #(\d+)\]/i);
  const review = name.match(/^Review: PR #(\d+)\b/i);
  const n = resolve?.[1] ?? review?.[1];
  if (!n) return null;

  if (host?.gitHost === 'agenthub') {
    const projectId = typeof host.projectId === 'string' ? host.projectId.trim() : '';
    // No project id means no native URL can be built. Return nothing rather
    // than falling through to a github.com link that would open the wrong PR.
    return projectId ? `/projects/${projectId}/pulls/${n}` : null;
  }

  const repoStr =
    typeof githubRepo === 'string' && githubRepo.includes('/') ? githubRepo.trim() : null;
  if (!repoStr) return null;

  return `https://github.com/${repoStr}/pull/${n}`;
}

export function isResolvePrSessionTitle(sessionName: string | null | undefined): boolean {
  if (sessionName == null || typeof sessionName !== 'string') return false;
  return /^\[Resolve PR #\d+\]/i.test(sessionName.trim());
}

export function parseResolvePrNumberFromTitle(
  sessionName: string | null | undefined,
): string | null {
  if (sessionName == null || typeof sessionName !== 'string') return null;
  const m = sessionName.trim().match(/^\[Resolve PR #(\d+)\]/i);
  return m ? m[1] : null;
}
