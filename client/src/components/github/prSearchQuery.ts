/**
 * Parse the GitHub-style query in the pull-request search box.
 *
 * The box shows qualifiers like `is:pr is:open`, so the list has to honour
 * them: typing `is:closed` on the Open tab must actually request closed PRs
 * rather than silently drop the qualifier and keep showing open ones.
 */
export interface ParsedPrSearchQuery {
  /**
   * State the qualifiers ask for, or null when the query names none — the
   * caller then keeps whatever the state tabs selected.
   */
  state: 'open' | 'closed' | 'all' | null;
  /**
   * Merge constraint the qualifiers ask for: true for `is:merged`, false for
   * `is:unmerged`, null when unconstrained.
   *
   * The list API has no "merged" state, so `is:merged` has to request `closed`
   * and then narrow the rows itself. Without this flag that narrowing is lost
   * and a query explicitly asking for merged PRs also lists abandoned ones.
   */
  merged: boolean | null;
  /** Free-text left after the qualifiers, lowercased for matching. */
  terms: string;
}

const QUALIFIER = /\bis:(pr|open|closed|merged|unmerged)\b/gi;

export function parsePrSearchQuery(query: string): ParsedPrSearchQuery {
  const found = new Set<string>();
  const terms = String(query || '')
    .replace(QUALIFIER, (_match, kind: string) => {
      found.add(kind.toLowerCase());
      return ' ';
    })
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

  // A merged PR is always closed, so `is:merged` implies the closed request.
  // `is:unmerged` implies nothing about state — an unmerged PR may be open.
  const wantsOpen = found.has('open');
  const wantsClosed = found.has('closed') || found.has('merged');
  let state: ParsedPrSearchQuery['state'] = null;
  if (wantsOpen && wantsClosed) state = 'all';
  else if (wantsOpen) state = 'open';
  else if (wantsClosed) state = 'closed';

  // Contradictory qualifiers cancel out rather than silently picking one.
  let merged: boolean | null = null;
  if (found.has('merged') && !found.has('unmerged')) merged = true;
  else if (found.has('unmerged') && !found.has('merged')) merged = false;

  return { state, merged, terms };
}

/** Has this PR actually been merged (as opposed to merely closed)? */
export function prIsMerged(pr: any): boolean {
  return Boolean(pr?.merged || pr?.merged_at);
}

/** Does this PR satisfy the query's merge constraint? */
export function prMatchesMerged(pr: any, merged: boolean | null): boolean {
  if (merged === null) return true;
  return prIsMerged(pr) === merged;
}

/** Does this PR match the free-text part of the query? */
export function prMatchesTerms(pr: any, terms: string): boolean {
  if (!terms) return true;
  const hay =
    `${pr?.title || ''} ${pr?.number || ''} ${pr?.user || ''} ${pr?.head || ''}`.toLowerCase();
  return terms.split(' ').every((term) => hay.includes(term));
}
