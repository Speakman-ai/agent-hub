/**
 * Best-effort PR URL from auto-typed session titles (Resolve PR / Review PR flows).
 * Does not hit the network. Prefer `kanban_cards.pr_url` when the session is linked to a card.
 *
 * @see server/routes/pr-resolve.ts — `[Resolve PR #N]`, `Review: PR #N`
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
 * Resolve the PR URL associated with a session, mirroring what the session
 * header / summary surface shows. Precedence: the linked kanban card's
 * `pr_url` (authoritative — written by `auto-git.ts` when a PR opens), then a
 * best-effort inference from the session title (Resolve/Review PR flows, or a
 * pasted PR URL).
 *
 * Used by the Finalize ship-gate so that any session attached to an open PR —
 * even one linked only via its title — can push commits to that PR instead of
 * being hard-blocked by the spawn guard.
 */
export function resolveSessionPrUrl(args: {
  sessionName: string | null | undefined;
  githubRepo: string | null | undefined;
  cardPrUrl: string | null | undefined;
}): string | null {
  const cardPrUrl =
    typeof args.cardPrUrl === 'string' && args.cardPrUrl.trim() ? args.cardPrUrl.trim() : null;
  if (cardPrUrl) return cardPrUrl;
  return inferPrUrlFromSessionTitle(args.sessionName, args.githubRepo);
}

/**
 * Sessions spawned from Pull Requests → Resolve PR push fixes to an
 * existing PR rather than opening a new one. Used to gate
 * resolve-PR chat flows (banner + skill guidance) so agents push fixes to
 * the existing PR instead of opening a new one.
 *
 * Mirror of `shared/utils/sessionTitlePr.js#isResolvePrSessionTitle`.
 */
export function isResolvePrSessionTitle(sessionName: string | null | undefined): boolean {
  if (sessionName == null || typeof sessionName !== 'string') return false;
  return /^\[Resolve PR #\d+\]/i.test(sessionName.trim());
}
