/**
 * Link a personal todo to an existing card, epic, or session (`POST /api/me/todos/:id/link`).
 * Card/epic carry `projectId`; session omits it (ownership-gated).
 */

/** Matches server + `todoLinkLabel`. */
export type LinkTargetType = 'card' | 'epic' | 'session';

/** Picker chip. */
export interface LinkOption {
  id: string;
  name: string;
}

/** Body for `POST /api/me/todos/:id/link`. */
export interface LinkPayload {
  targetType: LinkTargetType;
  targetId: string;
  projectId?: string;
}

/** Target types in picker order. */
export const LINK_TARGET_TYPES: LinkTargetType[] = ['card', 'epic', 'session'];

/** The picker's default target type. */
export const DEFAULT_LINK_TARGET_TYPE: LinkTargetType = 'card';

/** Matches `todoLinkLabel` ('card' reads as "Ticket"). */
export const LINK_TARGET_LABELS: Record<LinkTargetType, string> = {
  card: 'Ticket',
  epic: 'Epic',
  session: 'Session',
};

/** Card/epic payloads include `projectId`. Session omits it (ownership-gated). */
export function linkPayloadNeedsProject(type: LinkTargetType): boolean {
  return type === 'card' || type === 'epic';
}

/**
 * Normalize records to `{ id, name }`. Name from first present `nameKeys`
 * (`name` then `title`); fall back to id. Drop rows without an id.
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

/** Agents for one project. Compare `projectId` as string; drop missing. */
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

/** Case-insensitive substring over name, then id. Blank query is a no-op. */
export function filterLinkOptions(options: LinkOption[], query: string): LinkOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
}

/** Session omits `projectId`. Card/epic include it. */
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

/** Needs a target id. Card/epic also need a project. */
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
