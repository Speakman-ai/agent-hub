/**
 * Helpers for rendering system-role chat messages about PR lifecycle events.
 *
 * Mirrors the web client's `client/src/utils/prMessage.js` so the mobile chat
 * timeline can render the same "PR created" card that the web client shows.
 * Keep this file in sync with the web helper — the server persists a single
 * metadata shape and both clients parse it the same way.
 *
 * The server stores `messages.metadata` as a stringified JSON blob. For the
 * "PR created" marker (written in server/auto-git.ts broadcastAndMove) the
 * shape is:
 *
 *   { kind: 'pr_created', prUrl, prNumber, commitSha, commitTitle,
 *     cardId, cardTitle }
 *
 * cardId/cardTitle are null when the PR was created from an ad-hoc session
 * with no linked kanban card. Malformed metadata (unparseable JSON, wrong
 * kind, missing required fields) is treated as a non-match so the component
 * can fall back to a generic system-message render instead of crashing.
 */
export function parsePrCreatedMetadata(metadataString: any) {
    if (metadataString == null)
        return null;
    let parsed;
    try {
        parsed = typeof metadataString === 'string' ? JSON.parse(metadataString) : metadataString;
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object')
        return null;
    if (parsed.kind !== 'pr_created')
        return null;
    if (typeof parsed.prUrl !== 'string' || parsed.prUrl.length === 0)
        return null;
    return {
        prUrl: parsed.prUrl,
        prNumber: typeof parsed.prNumber === 'number' ? parsed.prNumber : null,
        commitSha: typeof parsed.commitSha === 'string' ? parsed.commitSha : '',
        commitTitle: typeof parsed.commitTitle === 'string' ? parsed.commitTitle : '',
        cardId: typeof parsed.cardId === 'string' ? parsed.cardId : null,
        cardTitle: typeof parsed.cardTitle === 'string' ? parsed.cardTitle : null,
    };
}
/**
 * Truncates a git SHA for display (first 7 chars matches GitHub's convention).
 * Returns '' for empty/invalid input so templates can safely render it.
 */
export function shortSha(sha: any) {
    if (typeof sha !== 'string' || sha.length === 0)
        return '';
    return sha.substring(0, 7);
}
