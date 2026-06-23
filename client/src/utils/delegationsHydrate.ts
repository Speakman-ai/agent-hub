/**
 * Delegation hydration helper — converts the snake_case rows returned by
 * `GET /api/sessions/:id/delegations` into the camelCase in-memory shape
 * consumed by `DelegateCard` / `DelegationPanel`.
 *
 * Why this exists
 * ---------------
 * `App.jsx` builds `delegations[sessionId] = { parentMessageId, tasks: [...] }`
 * purely from WebSocket events (`delegation_start`, `delegation_thinking`,
 * `delegation_agent_done`, …). After a page refresh, session switch, or any
 * scenario where the user opens a session that has *historical* `<delegate>`
 * blocks in saved assistant messages, that map is empty for the session — so
 * `DelegateCard.StatusBadge` falls through to the `null`-status branch and
 * renders the "Queued" badge with the misleading tooltip
 * "Awaiting dispatch confirmation from server".
 *
 * The server already exposes `GET /api/sessions/:sessionId/delegations`
 * (returns rows ordered `started_at DESC`), but no client surface fetched it.
 * `App.jsx` now calls this on session load and feeds the result through
 * {@link mapDelegationRowsToLiveShape} to seed the live-state cache so
 * historical cards render their real terminal status (`done`, `error`,
 * `cancelled`) instead of "Queued".
 *
 * Live WS events still win — the `delegation_start` handler in `App.jsx`
 * replaces the entry when a *new* round begins, which is the desired
 * behaviour because each new round can target different agents.
 */

/**
 * @param {Array<{
 *   id?: string,
 *   parent_message_id?: string,
 *   parentMessageId?: string,
 *   agent_id?: string,
 *   agentId?: string,
 *   agent_name?: string | null,
 *   agentName?: string | null,
 *   task?: string,
 *   status?: string,
 *   output?: string | null,
 *   error?: string | null,
 *   started_at?: string | null,
 *   startedAt?: string | null,
 * }> | null | undefined} rows
 * @returns {{ parentMessageId: string | null, tasks: Array<{
 *   delegationId: string | null,
 *   agentId: string | null,
 *   agentName: string | null,
 *   agentColor: string | null,
 *   task: string,
 *   status: string,
 *   content: string,
 *   output: string | null,
 *   error: string | null,
 *   startedAt: string | null,
 * }> } | null}
 */
export function mapDelegationRowsToLiveShape(rows: any) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const tasks: any[] = [];
  let parentMessageId = null;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    const agentId =
      typeof row.agent_id === 'string' && row.agent_id.length > 0
        ? row.agent_id
        : typeof row.agentId === 'string' && row.agentId.length > 0
          ? row.agentId
          : null;
    if (!agentId) continue;

    if (parentMessageId == null) {
      const pm =
        typeof row.parent_message_id === 'string'
          ? row.parent_message_id
          : typeof row.parentMessageId === 'string'
            ? row.parentMessageId
            : null;
      if (pm) parentMessageId = pm;
    }

    const agentName =
      typeof row.agent_name === 'string' && row.agent_name.length > 0
        ? row.agent_name
        : typeof row.agentName === 'string' && row.agentName.length > 0
          ? row.agentName
          : agentId;

    const status = typeof row.status === 'string' && row.status.length > 0 ? row.status : 'pending';

    const startedAt =
      typeof row.started_at === 'string'
        ? row.started_at
        : typeof row.startedAt === 'string'
          ? row.startedAt
          : null;

    tasks.push({
      delegationId: typeof row.id === 'string' ? row.id : null,
      agentId,
      agentName,
      agentColor: null,
      task: typeof row.task === 'string' ? row.task : '',
      status,
      content: '',
      output: typeof row.output === 'string' ? row.output : null,
      error: typeof row.error === 'string' ? row.error : null,
      startedAt,
    });
  }

  if (tasks.length === 0) return null;
  return { parentMessageId, tasks };
}
