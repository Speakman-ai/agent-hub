/**
 * Enrich REST-shaped PR list rows with merge/review/CI rollup fields that only
 * GitHub's GraphQL API (or `gh pr list --json`) exposes reliably. Used by
 * routes/pr-list.ts after a successful user-oauth REST list.
 */

export type CheckRollupItem = { name?: string; status?: string; conclusion?: string | null };

/** Same tri-state mapping as `mergeableFromCli` in pr-list.ts (GraphQL + gh enums). */
function mergeableFromGithubEnum(value: unknown): boolean | null {
  if (value === 'MERGEABLE') return true;
  if (value === 'CONFLICTING') return false;
  return null;
}

/**
 * Map GraphQL `Commit.statusCheckRollup.state` (aggregate) into a single synthetic
 * row so `summarizeChecks` can produce the same CI badge shape as the detail view.
 */
export function rollupStateToCheckItems(state: unknown): CheckRollupItem[] {
  const s = String(state || '').toUpperCase();
  if (!s) return [];
  if (s === 'SUCCESS') {
    return [{ name: 'Checks', status: 'completed', conclusion: 'success' }];
  }
  if (s === 'FAILURE' || s === 'ERROR') {
    return [{ name: 'Checks', status: 'completed', conclusion: 'failure' }];
  }
  if (s === 'PENDING' || s === 'EXPECTED') {
    return [{ name: 'Checks', status: 'queued', conclusion: '' }];
  }
  return [{ name: 'Checks', status: 'queued', conclusion: '' }];
}

/** Normalize `gh pr list` `statusCheckRollup` entries for summarizeChecks. */
export function normalizeCheckRollupItems(raw: unknown): CheckRollupItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CheckRollupItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const typename = String(row.__typename || '');
    if (typename === 'CheckRun') {
      out.push({
        name: typeof row.name === 'string' ? row.name : undefined,
        status: typeof row.status === 'string' ? row.status : undefined,
        conclusion:
          row.conclusion === null || row.conclusion === undefined ? null : String(row.conclusion),
      });
      continue;
    }
    if (typename === 'StatusContext') {
      const ctx = typeof row.context === 'string' ? row.context : 'status';
      const st = String(row.state || '').toUpperCase();
      // GitHub StatusState: SUCCESS / FAILURE / ERROR are terminal; EXPECTED and
      // PENDING are incomplete — must not map to `neutral`, which summarizeChecks
      // treats like success (see PR review on classic commit statuses).
      if (st === 'SUCCESS') {
        out.push({ name: ctx, status: 'COMPLETED', conclusion: 'success' });
      } else if (st === 'FAILURE' || st === 'ERROR') {
        out.push({ name: ctx, status: 'COMPLETED', conclusion: 'failure' });
      } else if (st === 'EXPECTED' || st === 'PENDING') {
        out.push({ name: ctx, status: 'queued', conclusion: '' });
      } else {
        out.push({ name: ctx, status: 'queued', conclusion: '' });
      }
    }
  }
  return out;
}

export async function postGraphql(
  bearerToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof json.message === 'string' ? json.message : res.statusText;
    throw new Error(`GitHub GraphQL failed (${res.status}): ${msg}`);
  }
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const first = json.errors[0] as { message?: string };
    throw new Error(`GitHub GraphQL errors: ${first?.message || 'unknown'}`);
  }
  return json;
}

function buildPullEnrichmentQuery(numbers: number[]): string {
  const parts = numbers.map((num) => {
    const alias = `p${num}`;
    return `${alias}: pullRequest(number: ${num}) {
      mergeable
      mergeStateStatus
      reviewDecision
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
            }
          }
        }
      }
    }`;
  });
  return `query PullListEnrichment($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${parts.join('\n')}
  }
}`;
}

function extractRollupStateFromEnrichmentNode(node: Record<string, unknown> | null): string | null {
  if (!node) return null;
  const commits = node.commits as Record<string, unknown> | undefined;
  const nodes = commits?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const first = nodes[0] as Record<string, unknown>;
  const commit = first?.commit as Record<string, unknown> | undefined;
  const rollup = commit?.statusCheckRollup as Record<string, unknown> | undefined;
  if (!rollup || typeof rollup.state !== 'string') return null;
  return rollup.state;
}

/**
 * Mutates each row in `pulls` (same objects returned from normalizePrSummary) by
 * attaching merge/review/check rollup when GraphQL returns data for that number.
 */
export async function enrichPullListRowsWithGraphql(opts: {
  owner: string;
  repo: string;
  bearerToken: string;
  pulls: Array<Record<string, unknown>>;
}): Promise<void> {
  const { owner, repo, bearerToken, pulls } = opts;
  if (pulls.length === 0) return;
  const numbers = pulls
    .map((p) => p.number)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
  if (numbers.length === 0) return;

  const query = buildPullEnrichmentQuery(numbers);
  let data: Record<string, unknown>;
  try {
    const res = await postGraphql(bearerToken, query, { owner, name: repo });
    data = (res.data as Record<string, unknown>) || {};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[PR List] GraphQL enrichment failed: ${msg.split('\n')[0]}`);
    return;
  }

  const repoPayload = data.repository as Record<string, unknown> | undefined;
  if (!repoPayload) return;

  for (const pr of pulls) {
    const num = pr.number;
    if (typeof num !== 'number') continue;
    const node = repoPayload[`p${num}`] as Record<string, unknown> | null | undefined;
    if (!node || typeof node !== 'object') continue;

    const mergeable = mergeableFromGithubEnum(node.mergeable);
    if (mergeable !== null) {
      pr.mergeable = mergeable;
    }
    if (node.mergeStateStatus != null) {
      pr.merge_state_status = String(node.mergeStateStatus);
    }
    if (node.reviewDecision !== undefined) {
      pr.review_decision = node.reviewDecision === null ? null : String(node.reviewDecision);
    }
    const rollupState = extractRollupStateFromEnrichmentNode(node);
    const fromState = rollupStateToCheckItems(rollupState);
    if (fromState.length > 0) {
      pr.check_rollup = fromState;
    }
  }
}
