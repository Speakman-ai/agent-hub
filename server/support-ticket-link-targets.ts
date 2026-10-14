/**
 * Search the things a support ticket can be linked to: kanban cards on the
 * project board and the project's live chat sessions. Backs the Link-to-card
 * autocomplete on the Customer Support page, which used to load up to 200
 * cards per column into a native <select> with no way to search.
 *
 * Cards already claimed by a support ticket are excluded (linking would 409).
 * Sessions whose linked card is claimed are excluded for the same reason.
 * A session with no card is still offered: linking creates a card for it.
 */
import type { KanbanCardRow, KanbanColumnRow, SessionRow, Stmts } from './types.js';
import { isColumnDone, isColumnCancelled } from './kanban-blockers.js';

export interface LinkTargetCard {
  id: string;
  short_id: number | null;
  title: string;
  column_name: string;
  session_id: string | null;
  updated_at: string;
}

export interface LinkTargetSession {
  id: string;
  name: string;
  agent_id: string;
  agent_name: string;
  card_id: string | null;
  card_short_id: number | null;
  card_title: string | null;
  updated_at: string;
}

export interface LinkTargetsResult {
  cards: LinkTargetCard[];
  sessions: LinkTargetSession[];
}

export interface LinkTargetsProject {
  id: string;
  agents: { id: string; name?: string }[];
}

export interface LinkTargetsOptions {
  query?: string;
  limit?: number;
  /** Read filter for sessions (owner / org-admin visibility). */
  canReadSession?: (sessionId: string) => boolean;
}

export const DEFAULT_LINK_TARGET_LIMIT = 20;
export const MAX_LINK_TARGET_LIMIT = 50;

function normalize(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase() : '';
}

/** `#123`, `123` match a short id exactly; anything else is a substring search. */
function shortIdQuery(q: string): number | null {
  const m = /^#?(\d+)$/.exec(q);
  return m ? Number(m[1]) : null;
}

function byUpdatedDesc<T extends { updated_at: string }>(a: T, b: T): number {
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

export function searchSupportTicketLinkTargets(
  stmts: Stmts,
  project: LinkTargetsProject,
  opts: LinkTargetsOptions = {},
): LinkTargetsResult {
  const q = (opts.query ?? '').trim().toLowerCase();
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_LINK_TARGET_LIMIT)),
    MAX_LINK_TARGET_LIMIT,
  );
  const wantShortId = shortIdQuery(q);

  const board = stmts.getKanbanBoard.get(project.id) as { id?: string } | undefined;
  const columnNameById = new Map<string, string>();
  const cardRows: KanbanCardRow[] = [];
  if (board?.id) {
    for (const col of stmts.getKanbanColumns.all(board.id) as KanbanColumnRow[]) {
      columnNameById.set(String(col.id), String(col.name ?? ''));
    }
    cardRows.push(...(stmts.getKanbanCards.all(board.id) as KanbanCardRow[]));
  }

  const cardBySession = new Map<string, KanbanCardRow>();
  for (const card of cardRows) {
    const sid = typeof card.session_id === 'string' ? card.session_id.trim() : '';
    if (sid && !cardBySession.has(sid)) cardBySession.set(sid, card);
  }

  const matchesCard = (card: KanbanCardRow): boolean => {
    if (!q) return true;
    if (wantShortId !== null && card.short_id === wantShortId) return true;
    return normalize(card.title).includes(q);
  };

  // Open work sorts ahead of Done/Cancelled so the likely target is on top.
  const isTerminal = (card: KanbanCardRow): boolean => {
    const name = columnNameById.get(String(card.column_id)) ?? '';
    return isColumnDone(name) || isColumnCancelled(name);
  };

  const cards: LinkTargetCard[] = cardRows
    .filter((c) => !c.support_ticket_id && matchesCard(c))
    .sort((a, b) => {
      const ta = isTerminal(a) ? 1 : 0;
      const tb = isTerminal(b) ? 1 : 0;
      if (ta !== tb) return ta - tb;
      return byUpdatedDesc(
        { updated_at: String(a.updated_at ?? '') },
        { updated_at: String(b.updated_at ?? '') },
      );
    })
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      short_id: c.short_id ?? null,
      title: c.title,
      column_name: columnNameById.get(String(c.column_id)) ?? '',
      session_id: c.session_id ?? null,
      updated_at: String(c.updated_at ?? ''),
    }));

  const sessions: LinkTargetSession[] = [];
  const seen = new Set<string>();
  for (const agent of project.agents ?? []) {
    if (!agent?.id) continue;
    for (const row of stmts.getSessions.all(agent.id) as SessionRow[]) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      if (opts.canReadSession && !opts.canReadSession(row.id)) continue;
      const card = cardBySession.get(row.id) ?? null;
      if (card?.support_ticket_id) continue;
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (q) {
        const hit =
          normalize(name).includes(q) ||
          (card !== null &&
            ((wantShortId !== null && card.short_id === wantShortId) ||
              normalize(card.title).includes(q)));
        if (!hit) continue;
      }
      sessions.push({
        id: row.id,
        name: name || card?.title || row.id,
        agent_id: agent.id,
        agent_name: agent.name || agent.id,
        card_id: card?.id ?? null,
        card_short_id: card?.short_id ?? null,
        card_title: card?.title ?? null,
        updated_at: String(row.updated_at ?? ''),
      });
    }
  }
  sessions.sort(byUpdatedDesc);

  return { cards, sessions: sessions.slice(0, limit) };
}
