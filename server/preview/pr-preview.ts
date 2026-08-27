/**
 * PR-scoped previews.
 *
 * Agent Hub previews are session/worktree-scoped: the runtime is keyed by
 * `session_id` (see {@link DevServerRuntime} and `worktree_preview_groups`).
 * A native Hub-hosted pull request, however, is keyed by its **head branch**
 * (`agent-hub/<agentId>/session-<first8-of-session-id>`; minted in
 * `server/worktree.ts`). There is deliberately no per-PR preview runtime —
 * the old PR-env/container-pool subsystem was removed (see wiki
 * `preview-model-worktree-previews-only`).
 *
 * So "launch a preview for this PR" resolves the session that owns the PR's
 * head branch and drives the existing session preview surface
 * (`startSessionPreview` / `getSessionPreviewStateEvent` /
 * `DevServerRuntime.stopBySessionId`). This module holds the pure bridge:
 * head-branch → session-id-prefix → session row. It has no runtime
 * dependency and never spawns anything, so it is unit-testable in isolation.
 */
import { SESSION_BRANCH_REF_RE } from '../kanban-pr-link.js';
import type { SessionRow } from '../types.js';

/**
 * Extract the 8-hex session-id prefix that a native PR head branch encodes,
 * or `null` when the branch does not name a session (e.g. a resolve-PR
 * session pinned directly onto an arbitrary head branch, or a branch created
 * outside the Hub). Lower-cased for a case-insensitive `id LIKE` lookup.
 */
export function sessionIdPrefixFromHeadBranch(
  headBranch: string | null | undefined,
): string | null {
  if (!headBranch) return null;
  const m = headBranch.match(SESSION_BRANCH_REF_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * The canonical branch a session's worktree is cut on, minted in
 * `worktree.ts` as `agent-hub/<agentId>/session-<first8-of-id>` where
 * `agentId === session.agent_id`. This is the full identity a PR head branch
 * must match to resolve to this session — the 8-hex id prefix alone is NOT a
 * sufficient (or safe) key.
 */
export function canonicalSessionBranch(session: Pick<SessionRow, 'id' | 'agent_id'>): string {
  return `agent-hub/${session.agent_id}/session-${session.id.slice(0, 8)}`;
}

/**
 * Resolve the live session that owns a native PR's head branch, or `null`.
 *
 * Security-critical: the head branch only encodes an 8-hex id prefix, which is
 * not an authorization boundary. A branch named with another session's (or
 * another tenant's) prefix must NOT resolve that session. So resolution
 * requires BOTH:
 *   1. Full canonical-branch identity — `canonicalSessionBranch(session)` must
 *      equal the PR head branch exactly (pins agent id + id prefix together).
 *   2. Tenant scope — the session must belong to `expectedProjectId`
 *      (`resolveProjectId` maps a session to its project via its agent).
 *
 * `lookupByIdPrefix` returns EVERY session sharing the 8-hex prefix (a rare
 * collision set) so a `LIMIT 1` cannot hide the correct match behind a
 * wrong-tenant row. A soft-deleted session is skipped — a gone session has no
 * reachable worktree, so a preview for it would fail anyway.
 */
export function resolveSessionForPrHeadBranch(
  headBranch: string | null | undefined,
  expectedProjectId: string,
  lookupByIdPrefix: (prefix: string) => SessionRow[],
  resolveProjectId: (session: SessionRow) => string | null,
): SessionRow | null {
  const prefix = sessionIdPrefixFromHeadBranch(headBranch);
  if (!prefix) return null;
  const branch = String(headBranch).trim();
  for (const session of lookupByIdPrefix(prefix)) {
    if (!session || session.deleted_at) continue;
    // (1) The 8-hex prefix is not the boundary — require the full branch.
    if (canonicalSessionBranch(session) !== branch) continue;
    // (2) Never cross the tenant boundary, even on a full-branch match.
    if (resolveProjectId(session) !== expectedProjectId) continue;
    return session;
  }
  return null;
}
