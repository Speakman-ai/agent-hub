/**
 * linkTodo.ts — the pure logic behind the link-to-existing picker (spec
 * TODO-TO-TICKET LINK op), shared 1:1 between the web `LinkTodoModal` and the
 * mobile one so both clients normalize the same option lists, build the same
 * write payload, and gate the submit identically. Kept free of React / network
 * so it is unit-testable in isolation.
 *
 * The picker associates a personal todo with an ALREADY-EXISTING card, epic, or
 * session (nothing is created — that is the promote op). It POSTs
 * `POST /api/me/todos/:id/link` with `{ targetType, targetId, projectId? }`.
 * A card / epic target is project-scoped and carries `projectId`; a session
 * target is gated by session ownership server-side and omits `projectId`.
 */

/** Polymorphic link target type — mirrors the server + `todoLinkLabel`. */
export type LinkTargetType = 'card' | 'epic' | 'session';

/** A link target (card / epic / session / agent) narrowed to picker chips. */
export interface LinkOption {
  id: string;
  name: string;
}

/** The exact body `POST /api/me/todos/:id/link` accepts. */
export interface LinkPayload {
  targetType: LinkTargetType;
  targetId: string;
  projectId?: string;
}

/** Target types in picker order. */
export const LINK_TARGET_TYPES: LinkTargetType[] = ['card', 'epic', 'session'];

/** The picker's default target type. */
export const DEFAULT_LINK_TARGET_TYPE: LinkTargetType = 'card';

/**
 * Human label per target type. Matches the badge wording produced by
 * `todoLinkLabel` so the picker toggle and the resulting link badge agree
 * ('card' reads as "Ticket").
 */
export const LINK_TARGET_LABELS: Record<LinkTargetType, string> = {
  card: 'Ticket',
  epic: 'Epic',
  session: 'Session',
};

/**
 * Whether a target type is project-scoped — i.e. the link payload carries a
 * `projectId`. A card or epic lives on a project board; a session is gated by
 * ownership and ignores `projectId` server-side. (Note: the picker still needs
 * a project selected for a session, to scope which agents' sessions to browse —
 * that is a UI concern, not part of the payload.)
 */
export function linkPayloadNeedsProject(type: LinkTargetType): boolean {
  return type === 'card' || type === 'epic';
}

/**
 * Normalize an unknown array of records (board cards / epics, project agents,
 * agent sessions) into `{ id, name }` picker options. Ids are stringified; the
 * name is taken from the first present `nameKeys` field (defaulting to `name`
 * then `title`, which covers epics/agents/sessions via `name` and cards via
 * `title`), falling back to the id so an option is never blank. Rows without a
 * usable id are dropped.
 */
export function normalizeLinkOptions(
  rows: unknown,
  nameKeys: readonly string[] = ['name', 'title'],
): LinkOption[] {
  if (!Array.isArray(rows)) return [];
  const out: LinkOption[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    if (rec.id === undefined || rec.id === null) continue;
    const id = String(rec.id);
    if (!id) continue;
    let name = '';
    for (const key of nameKeys) {
      const v = rec[key];
      if (typeof v === 'string' && v.trim()) {
        name = v;
        break;
      }
    }
    out.push({ id, name: name || id });
  }
  return out;
}

/**
 * Filter a project-agent list down to a single project's agents and normalize
 * to picker options. An agent's `projectId` is compared as a string so a
 * numeric id from the API still matches. Agents with no `projectId` are dropped
 * (they can't be attributed to the selected project).
 */
export function agentsForProject(agents: unknown, projectId: string): LinkOption[] {
  if (!Array.isArray(agents) || !projectId) return [];
  const scoped = agents.filter(
    (a) =>
      !!a &&
      typeof a === 'object' &&
      (a as Record<string, unknown>).projectId !== undefined &&
      (a as Record<string, unknown>).projectId !== null &&
      String((a as Record<string, unknown>).projectId) === projectId,
  );
  return normalizeLinkOptions(scoped);
}

/**
 * Case-insensitive substring filter over option names (and ids as a fallback),
 * used by the picker's search box. A blank query returns the list unchanged.
 */
export function filterLinkOptions(options: LinkOption[], query: string): LinkOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
}

/**
 * Build the link request body from the picker selections. A session target
 * omits `projectId` entirely (the server gates it by ownership); a card / epic
 * target includes it.
 */
export function buildLinkPayload(input: {
  targetType: LinkTargetType;
  targetId: string;
  projectId?: string | null;
}): LinkPayload {
  if (input.targetType === 'session') {
    return { targetType: 'session', targetId: input.targetId };
  }
  return {
    targetType: input.targetType,
    targetId: input.targetId,
    projectId: input.projectId ?? undefined,
  };
}

/**
 * Whether the picker has enough selected to submit. Always requires a chosen
 * target id and no in-flight submit / load. A card or epic additionally
 * requires a project; a session does not.
 */
export function canSubmitLink(input: {
  targetType: LinkTargetType;
  targetId: string;
  projectId?: string | null;
  submitting: boolean;
  loading: boolean;
}): boolean {
  if (input.submitting || input.loading) return false;
  if (!input.targetId) return false;
  if (linkPayloadNeedsProject(input.targetType)) return !!input.projectId;
  return true;
}
