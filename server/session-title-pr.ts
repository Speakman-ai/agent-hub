/**
 * Best-effort PR URL from auto-typed session titles (Resolve PR / Review PR flows).
 * Does not hit the network. Prefer `kanban_cards.pr_url` when the session is linked to a card.
 *
 * @see server/routes/pr-resolve.ts — `[Resolve PR #N]`
 * @see server/routes/webhooks.ts — `Review: PR #N`
 */
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

/**
 * Sessions spawned from Pull Requests → Resolve PR push fixes to an
 * existing PR rather than opening a new one. Used to gate
 * `POST /api/sessions/:id/create-pr` so the action does not silently
 * fork a second PR when the user clicks "Create ticket & PR" inside a
 * resolve-PR chat.
 *
 * Mirror of `shared/utils/sessionTitlePr.js#isResolvePrSessionTitle`.
 */
export function isResolvePrSessionTitle(sessionName: string | null | undefined): boolean {
  if (sessionName == null || typeof sessionName !== 'string') return false;
  return /^\[Resolve PR #\d+\]/i.test(sessionName.trim());
}
