/**
 * Phase-placement checks for card blockers.
 *
 * Phases run in saved order and a phase only finishes when every card in it is
 * Done. So when a phased card waits on a blocker that its own phase run can
 * never reach, the phase stalls with no error:
 *
 * - `later_phase`: the blocker sits in a later phase of the same epic. That
 *   phase cannot start until this one finishes, which needs the blocked card,
 *   which needs the blocker. A guaranteed deadlock.
 * - `other_epic`: the blocker belongs to a different epic (or none). This
 *   epic's phase runs never dispatch it, so it only lands if someone works it
 *   separately, e.g. that epic's own dispatch.
 *
 * Callers use this to warn when the edge is created and to explain the stall
 * when autonomous dispatch skips the blocked card.
 */

import { isColumnDone } from './kanban-blockers.js';
import type {
  KanbanCardRow,
  KanbanColumnRow,
  KanbanEpicRow,
  KanbanPhaseRow,
  Stmts,
} from './types.js';

export type BlockerPlacementKind = 'later_phase' | 'other_epic';

export interface BlockerPlacementHazard {
  kind: BlockerPlacementKind;
  message: string;
}

export interface PlacementCard {
  id: string;
  title: string;
  epic_id: string | null;
  phase_id: string | null;
}

export interface PlacementPhase {
  id: string;
  epic_id: string;
  name: string;
  position: number;
}

export interface PlacementLookups {
  phaseById: (id: string) => PlacementPhase | undefined;
  epicNameById?: (id: string) => string | undefined;
}

/**
 * Classify the edge "`blocked` is blocked by `blocker`". Returns null when the
 * phase order can satisfy it (same phase, earlier phase, or the blocked card
 * is not in a phase at all).
 */
export function blockerPlacementHazard(
  blocked: PlacementCard,
  blocker: PlacementCard,
  lookups: PlacementLookups,
): BlockerPlacementHazard | null {
  if (!blocked.phase_id || !blocked.epic_id) return null;
  const blockedPhase = lookups.phaseById(blocked.phase_id);
  if (!blockedPhase) return null;

  if (blocker.epic_id !== blocked.epic_id) {
    const epicName = blocker.epic_id ? lookups.epicNameById?.(blocker.epic_id) : undefined;
    const where = blocker.epic_id ? `another epic${epicName ? ` (${epicName})` : ''}` : 'no epic';
    return {
      kind: 'other_epic',
      message:
        `"${blocker.title}" is in ${where}, so this epic's phase runs will never dispatch it. ` +
        `"${blocked.title}" waits in ${blockedPhase.name} until it lands some other way. ` +
        `Move the blocker into ${blockedPhase.name} or an earlier phase of this epic.`,
    };
  }

  if (!blocker.phase_id || blocker.phase_id === blocked.phase_id) return null;
  const blockerPhase = lookups.phaseById(blocker.phase_id);
  if (!blockerPhase || blockerPhase.position <= blockedPhase.position) return null;

  return {
    kind: 'later_phase',
    message:
      `"${blocker.title}" is in ${blockerPhase.name}, which runs after ${blockedPhase.name}. ` +
      `${blockedPhase.name} cannot finish until "${blocked.title}" is Done, so neither will start. ` +
      `Move the blocker into ${blockedPhase.name} or an earlier phase, or reorder the phases by dependencies.`,
  };
}

/** DB-backed lookups for {@link blockerPlacementHazard}. */
export function placementLookupsFromStmts(stmts: Stmts): PlacementLookups {
  return {
    phaseById: (id) => stmts.getKanbanPhase.get(id) as KanbanPhaseRow | undefined,
    epicNameById: (id) => (stmts.getKanbanEpic.get(id) as KanbanEpicRow | undefined)?.name,
  };
}

/**
 * Load both cards by id and classify the edge. Null when either card is
 * missing or the blocker is already Done: a satisfied dependency cannot stall
 * a phase wherever it sits.
 */
export function blockerPlacementHazardById(
  stmts: Stmts,
  blockedCardId: string,
  blockerCardId: string,
): BlockerPlacementHazard | null {
  const blocked = stmts.getKanbanCard.get(blockedCardId) as KanbanCardRow | undefined;
  const blocker = stmts.getKanbanCard.get(blockerCardId) as KanbanCardRow | undefined;
  if (!blocked || !blocker) return null;
  const blockerColumn = stmts.getKanbanColumn.get(blocker.column_id) as KanbanColumnRow | undefined;
  if (isColumnDone(blockerColumn?.name)) return null;
  return blockerPlacementHazard(
    toPlacementCard(blocked),
    toPlacementCard(blocker),
    placementLookupsFromStmts(stmts),
  );
}

function toPlacementCard(c: KanbanCardRow): PlacementCard {
  return { id: c.id, title: c.title, epic_id: c.epic_id ?? null, phase_id: c.phase_id ?? null };
}
