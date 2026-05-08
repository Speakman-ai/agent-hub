/**
 * Best-effort PR URL from session titles (Resolve PR / Review PR flows).
 * Mirrors server/session-title-pr.ts for web + mobile clients.
 */

const GITHUB_PULL_IN_TITLE_RE = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

/**
 * @param {string | null | undefined} sessionName
 * @param {string | null | undefined} githubRepo owner/repo
 * @returns {string | null}
 */
export function inferPrUrlFromSessionTitle(sessionName, githubRepo) {
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
  // Review: titles are handled here for URL inference only; UI "resolve flow" gating uses isResolvePrSessionTitle ([Resolve PR #N] only).
  const review = name.match(/^Review: PR #(\d+)\b/i);
  const n = resolve?.[1] ?? review?.[1];
  if (!n) return null;

  return `https://github.com/${repoStr}/pull/${n}`;
}

/**
 * Sessions spawned from Pull Requests → Resolve PR (existing PR; no new PR banner).
 * @param {string | null | undefined} sessionName
 */
export function isResolvePrSessionTitle(sessionName) {
  if (sessionName == null || typeof sessionName !== 'string') return false;
  return /^\[Resolve PR #\d+\]/i.test(sessionName.trim());
}

/**
 * @param {string | null | undefined} sessionName
 * @returns {string | null} PR number digits only
 */
export function parseResolvePrNumberFromTitle(sessionName) {
  if (sessionName == null || typeof sessionName !== 'string') return null;
  const m = sessionName.trim().match(/^\[Resolve PR #(\d+)\]/i);
  return m ? m[1] : null;
}
