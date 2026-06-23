// Pure helpers for the Chat screen "session extras" — the session summary
// sheet (linked PR / skills / agent roster) and the View-changes entry point.
//
// Lives in src/utils/ (not inside a component) so the normalization rules can
// be asserted by plain Vitest tests without a React Native renderer. The
// summary shape mirrors GET /api/sessions/:id/summary (server/routes/
// sessions.ts):
//
//   {
//     session: { id, name, engine, model, updatedAt },
//     projectId,
//     projectGithubRepo,
//     linkedCard: { id, title, pr_url, review_status, columnName } | null,
//     finalizePrUrl,        // string | null (only when no linkedCard PR)
//     sessionTitlePrUrl,    // string | null (only when neither above)
//     runSnapshot,
//     skills: [{ id, skillId, status, source, injectedBytes, createdAt }],
//   }
import { prNumberFromUrl } from './prFormatting';
/**
 * Resolve the PR URL the summary sheet should surface, in the same precedence
 * order the web SessionSummarySidebar uses: kanban-card PR, then the latest
 * finalize-run PR, then a PR inferred from the session title.
 *
 * @param {object|null|undefined} summary
 * @returns {string|null}
 */
export function pickLinkedPrUrl(summary: any) {
    return (summary?.linkedCard?.pr_url ??
        summary?.finalizePrUrl ??
        summary?.sessionTitlePrUrl ??
        null);
}
/**
 * Badge descriptor for the linked PR, derived from the kanban card's
 * review_status (mobile does not fetch full PR detail like the web sidebar
 * does). `tone` is a semantic key the component maps to theme colors.
 *
 * @param {object|null|undefined} summary
 * @returns {{key: string, label: string, tone: 'red'|'emerald'|'yellow'|'purple'|'blue'}|null}
 */
export function linkedPrBadge(summary: any) {
    if (!pickLinkedPrUrl(summary))
        return null;
    const review = String(summary?.linkedCard?.review_status || '').toLowerCase();
    if (review === 'merged')
        return { key: 'merged', label: 'Merged', tone: 'purple' };
    if (review === 'changes_requested')
        return { key: 'pending_revisions', label: 'Pending revisions', tone: 'red' };
    if (review === 'approved')
        return { key: 'approved', label: 'Approved', tone: 'emerald' };
    if (review === 'awaiting_review' || review === 'reviewing')
        return { key: 'pending_review', label: 'Pending review', tone: 'yellow' };
    return { key: 'linked', label: 'Linked PR', tone: 'blue' };
}
/**
 * Collapse skill_invocations rows to one entry per skill id, keeping the most
 * recent invocation (by created_at). Port of the web client's
 * dedupeSkillInvocations — accepts snake_case or camelCase rows.
 *
 * @param {Array<object>|null|undefined} rows
 * @returns {Array<object>}
 */
export function dedupeSkillInvocations(rows: any) {
    if (!Array.isArray(rows))
        return [];
    const byId = new Map();
    for (const row of rows) {
        if (!row || typeof row !== 'object')
            continue;
        const skillId = row.skill_id ?? row.skillId;
        if (!skillId)
            continue;
        const createdAt = row.created_at ?? row.createdAt ?? '';
        const existing = byId.get(skillId);
        if (!existing) {
            byId.set(skillId, row);
            continue;
        }
        const existingCreatedAt = existing.created_at ?? existing.createdAt ?? '';
        // Lexicographic compare on ISO-8601 strings == chronological order.
        if (String(createdAt) >= String(existingCreatedAt)) {
            byId.set(skillId, row);
        }
    }
    return Array.from(byId.values());
}
/**
 * Human-readable size for skill injection byte counts ("512 B", "1.5 KB").
 * @param {number} bytes
 * @returns {string}
 */
export function formatInjectedBytes(bytes: any) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return '';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * Flatten the raw /summary payload into the fields the mobile sheet renders.
 * Defensive about missing sections so a partial server response never throws.
 *
 * @param {object|null|undefined} data raw GET /api/sessions/:id/summary body
 */
export function normalizeSessionSummary(data: any) {
    const linkedPrUrl = pickLinkedPrUrl(data);
    return {
        sessionName: data?.session?.name || '',
        engine: data?.session?.engine || '',
        model: data?.session?.model || '',
        linkedPrUrl,
        prNumber: linkedPrUrl ? prNumberFromUrl(linkedPrUrl) : null,
        prBadge: linkedPrBadge(data),
        linkedCardId: data?.linkedCard?.id || '',
        linkedCardTitle: data?.linkedCard?.title || '',
        linkedCardColumn: data?.linkedCard?.columnName || '',
        skills: dedupeSkillInvocations(data?.skills).map((s: any) => ({
            id: s.id ?? s.skillId ?? s.skill_id,
            skillId: s.skillId ?? s.skill_id,
            status: s.status ?? null,
            injectedBytes: s.injectedBytes ?? s.injected_bytes ?? null,
            createdAt: s.createdAt ?? s.created_at ?? null,
        })),
    };
}
/**
 * Whether the "View changes" entry point should render for a session.
 * Agent Hub sessions are worktree-backed by default (`use_worktree` defaults
 * to 1 — see worktreeState.resolveSessionWorktree), so we default to showing
 * the button and only hide it when the row explicitly opted out.
 *
 * @param {object|null|undefined} session session row from the sessions list
 * @returns {boolean}
 */
export function shouldShowViewChanges(session: any) {
    if (!session)
        return true;
    return session.use_worktree !== 0;
}
/**
 * Split a session's agent roster into executor + advisors for display.
 * @param {Array<{role?: string}>|null|undefined} sessionAgents
 */
export function splitSessionRoster(sessionAgents: any) {
    const list = Array.isArray(sessionAgents) ? sessionAgents.filter(Boolean) : [];
    return {
        executor: list.find((a: any) => a.role === 'executor') || null,
        advisors: list.filter((a: any) => a.role === 'advisor'),
    };
}
