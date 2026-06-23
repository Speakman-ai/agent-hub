/**
 * prReviewActions.js — pure payload builders + capability gating for the
 * mobile PR detail actions (review / comment / edit / reopen).
 *
 * The server contracts live in `server/routes/pulls-native.ts`:
 *   - POST  .../pulls/:n/reviews   { state: approved|changes_requested|commented, body? }
 *     ('commented' requires a non-empty body)
 *   - POST  .../pulls/:n/comments  { filePath, line, side?: old|new, body }
 *   - PATCH .../pulls/:n           { title?, body? } (open PRs only)
 *   - POST  .../pulls/:n/reopen    (closed, non-merged PRs only)
 *
 * The UI speaks GitHub verbs (APPROVE / REQUEST_CHANGES / COMMENT); these
 * builders translate to the server's `state` values. All builders return
 * `{ ok: true, payload }` or `{ ok: false, error }` — no throwing, so the
 * sheets can render validation errors inline.
 */
export const REVIEW_EVENTS = [
    { event: 'APPROVE', state: 'approved', label: 'Approve' },
    { event: 'REQUEST_CHANGES', state: 'changes_requested', label: 'Request changes' },
    { event: 'COMMENT', state: 'commented', label: 'Comment' },
];
/** Server `state` for a UI review event, or null when unknown. */
export function reviewStateForEvent(event: any) {
    const found = REVIEW_EVENTS.find((e: any) => e.event === event);
    return found ? found.state : null;
}
/**
 * Build the body for POST .../pulls/:n/reviews.
 * @param {'APPROVE'|'REQUEST_CHANGES'|'COMMENT'} event
 * @param {string} [body]
 */
export function buildReviewPayload(event: any, body: any = '') {
    const state = reviewStateForEvent(event);
    if (!state) {
        return { ok: false, error: `Unknown review action: ${String(event)}` };
    }
    const text = typeof body === 'string' ? body.trim() : '';
    if (state === 'commented' && !text) {
        return { ok: false, error: 'A comment needs some text.' };
    }
    return { ok: true, payload: { state, body: text } };
}
/**
 * A "general PR comment" is a review with state 'commented' — the native
 * PR surface has no standalone issue-comment endpoint (inline comments
 * are file+line anchored). Same approach as the web review composer.
 */
export function buildGeneralCommentPayload(body: any) {
    return buildReviewPayload('COMMENT', body);
}
/** Build the body for PATCH .../pulls/:n (edit title/description). */
export function buildEditPrPayload({ title, body }: any = {}) {
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t)
        return { ok: false, error: 'Title is required.' };
    return { ok: true, payload: { title: t, body: typeof body === 'string' ? body : '' } };
}
/** Build the body for POST .../pulls/:n/comments (inline diff comment). */
export function buildInlineCommentPayload({ filePath, line, side, body }: any = {}) {
    const path = typeof filePath === 'string' ? filePath.trim() : '';
    if (!path)
        return { ok: false, error: 'A file path is required.' };
    const n = Number.parseInt(String(line), 10);
    if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: 'Line must be a positive number.' };
    }
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text)
        return { ok: false, error: 'Comment text is required.' };
    return {
        ok: true,
        payload: { filePath: path, line: n, side: side === 'old' ? 'old' : 'new', body: text },
    };
}
/**
 * What actions the detail payload supports — mirrors the web gating in
 * `client/src/components/PullRequestsPage.jsx`: review/comment/edit are
 * native-only (Agent Hub-hosted PRs, `source === 'agenthub'`) and require
 * an open PR; reopen needs a closed-but-not-merged native PR. The diff
 * view works for both native and GitHub PRs via the `/api/pr/files`
 * proxy, keyed on the PR's html URL.
 */
export function prDetailCapabilities(detail: any) {
    const pr = detail && typeof detail === 'object' ? detail.pr : null;
    const isNative = detail?.source === 'agenthub';
    const isOpen = String(pr?.state || '').toLowerCase() === 'open';
    const isMerged = Boolean(pr?.merged_at);
    const prUrl = typeof pr?.html_url === 'string' && pr.html_url ? pr.html_url : null;
    return {
        isNative,
        isOpen,
        isMerged,
        prUrl,
        canViewFiles: Boolean(prUrl),
        canReview: isNative && isOpen,
        canComment: isNative && isOpen,
        canEdit: isNative && isOpen,
        canReopen: isNative && !isOpen && !isMerged,
        // Native html_urls are in-app client routes — only real GitHub URLs
        // get an external "open" affordance (web parity).
        externalUrl: prUrl && /^https?:\/\//i.test(prUrl) ? prUrl : null,
    };
}
