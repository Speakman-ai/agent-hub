/**
 * Sticky bot comment on the GitHub PR itself, surfacing the preview-env
 * URL (when ready), build failure reason, or torn-down state. This is in
 * addition to — not a replacement for — the kanban-card system comment
 * already posted by `notifyPrEnvComment` in pr-env-dispatch.ts.
 *
 * Idempotency: the comment body is wrapped in HTML marker comments
 * (`<!-- agent-hub:preview-env:start --> ... <!-- agent-hub:preview-env:end -->`).
 * On rebuild we list issue-comments on the PR, find one whose body
 * contains the start marker, and PATCH it in place. If no existing one
 * is found we POST a new comment. This is how Vercel and Render keep
 * their preview-env comments tidy across `synchronize` events.
 *
 * Auth: piggybacks on the Reviewer GitHub App (the same App used by
 * `server/check-runs.ts` etc.) — a `pull_requests: write` scope is
 * granted in the manifest, which is the same scope used to post review
 * comments. We get an installation token via `getInstallationToken`.
 */

export const STICKY_MARKER_START = '<!-- agent-hub:preview-env:start -->';
export const STICKY_MARKER_END = '<!-- agent-hub:preview-env:end -->';

export type PrStickyCommentPayload =
  | { kind: 'ready'; previewUrl: string; port: number; commitSha?: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'torndown' };

/**
 * Pure body builder. Returns the full markdown body INCLUDING the HTML
 * markers, so the caller can pipe it straight into the GitHub API.
 *
 * Always wrapped in markers so a future state change (e.g. rebuild after
 * a previous failure) finds and replaces the existing comment in place.
 */
export function buildStickyCommentBody(payload: PrStickyCommentPayload): string {
  let inner = '';
  switch (payload.kind) {
    case 'ready': {
      const shaLine = payload.commitSha ? `\nCommit: \`${payload.commitSha.slice(0, 7)}\`` : '';
      inner =
        `### 🚀 Preview environment ready\n\n` +
        `**URL:** ${payload.previewUrl}\n` +
        `**Port:** \`${payload.port}\`${shaLine}\n\n` +
        `_Rebuilt automatically on every push to this PR. Torn down when the PR is closed._`;
      break;
    }
    case 'failed': {
      inner =
        `### ⚠️ Preview environment build failed\n\n` +
        `${payload.reason}\n\n` +
        `_Push a new commit to retry; the build will run again automatically._`;
      break;
    }
    case 'torndown': {
      inner =
        `### 🧹 Preview environment torn down\n\n` +
        `The PR was closed/merged and the preview container has been removed.`;
      break;
    }
  }
  return `${STICKY_MARKER_START}\n${inner}\n${STICKY_MARKER_END}`;
}

/**
 * Minimal shape of a GitHub issue-comment we care about for sticky
 * upsert. The list endpoint returns many more fields; we read only the
 * ones we need.
 */
export interface GitHubIssueComment {
  id: number;
  body?: string;
}

/**
 * Injectable HTTP client. Production wiring uses a wrapper around
 * `fetch` that attaches a fresh installation token. Tests replace it
 * with a fake that asserts on the request shape.
 *
 * The `path` is the API path *after* `https://api.github.com`, e.g.
 * `/repos/acme/foo/issues/12/comments`.
 */
export interface GitHubApiClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown): Promise<unknown>;
}

export interface UpsertStickyParams {
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}

/**
 * Find an existing sticky comment by its start-marker, or null if none.
 *
 * GitHub returns comments in ascending-creation order; ours will almost
 * always be on the first page (we created it on `opened` before any
 * humans have likely commented). Bumping per_page to 100 keeps us off
 * pagination for the realistic case while staying within rate-limit
 * budget. If the PR has >100 comments and ours is buried, we'd fall
 * through and post a duplicate; acceptable for v1, fixable later by
 * walking `Link: rel="next"`.
 */
export async function findExistingStickyComment(
  client: GitHubApiClient,
  params: { owner: string; repo: string; prNumber: number },
): Promise<GitHubIssueComment | null> {
  const list = (await client.get(
    `/repos/${params.owner}/${params.repo}/issues/${params.prNumber}/comments?per_page=100`,
  )) as GitHubIssueComment[] | unknown;
  if (!Array.isArray(list)) return null;
  for (const c of list as GitHubIssueComment[]) {
    if (typeof c?.body === 'string' && c.body.includes(STICKY_MARKER_START)) {
      return c;
    }
  }
  return null;
}

/**
 * Upsert the sticky preview-env comment on the PR.
 *
 * - Found existing → PATCH it in place (single comment per PR).
 * - Not found → POST a new comment.
 *
 * Returns the comment id on success, or null if the operation was
 * skipped (e.g. malformed inputs). Errors are *thrown* — the caller
 * (dispatch) is responsible for swallowing them so a transient GitHub
 * API blip doesn't take down the build path.
 */
export async function upsertPrStickyComment(
  client: GitHubApiClient,
  params: UpsertStickyParams,
): Promise<number | null> {
  if (!params.owner || !params.repo || !params.prNumber) return null;

  const existing = await findExistingStickyComment(client, {
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
  });
  if (existing) {
    await client.patch(`/repos/${params.owner}/${params.repo}/issues/comments/${existing.id}`, {
      body: params.body,
    });
    return existing.id;
  }

  const created = (await client.post(
    `/repos/${params.owner}/${params.repo}/issues/${params.prNumber}/comments`,
    { body: params.body },
  )) as { id?: number } | unknown;
  if (
    created &&
    typeof created === 'object' &&
    typeof (created as { id?: number }).id === 'number'
  ) {
    return (created as { id: number }).id;
  }
  return null;
}
