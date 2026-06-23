const GITHUB_PULL_IN_TITLE_RE = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

export function inferPrUrlFromSessionTitle(
  sessionName: string | null | undefined,
  githubRepo: string | null | undefined,
): string | null {
  if (sessionName == null || typeof sessionName !== 'string') return null;
  const name = sessionName.trim();
  if (!name) return null;

  const urlHit = name.match(GITHUB_PULL_IN_TITLE_RE);
  if (urlHit) {
    return `https://github.com/${urlHit[1]}/${urlHit[2]}/pull/${urlHit[3]}`;
  }

  const repoStr =
    typeof githubRepo === 'string' && githubRepo.includes('/') ? githubRepo.trim() : null;
  if (!repoStr) return null;

  const resolve = name.match(/^\[Resolve PR #(\d+)\]/i);
  const review = name.match(/^Review: PR #(\d+)\b/i);
  const n = resolve?.[1] ?? review?.[1];
  if (!n) return null;

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
