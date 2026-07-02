import type { BroadcastFn, KanbanCardRow, KanbanEpicRow, Stmts } from './types.js';

/**
 * Dependencies needed to disarm an empty autonomous epic. A structural subset
 * of `RouteDeps` so route handlers can pass their own `deps` straight through,
 * and unit tests can supply a minimal fake without standing up the whole
 * autonomous subsystem.
 */
export interface DisableAutonomousDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  scheduleAutonomousEpic: (projectId: string, epic: KanbanEpicRow) => void;
}

/**
 * Turn off an epic's autonomous mode once its last card is removed.
 *
 * The dispatch tick only disarms autonomous after every card reaches a Done
 * column, and that check is guarded by `cards.length > 0`. An epic whose cards
 * are all deleted or unlinked drops to zero cards and would otherwise keep an
 * idle 60s safety-net cron ticking forever with nothing to dispatch.
 *
 * Call this right after a card leaves an epic (card delete, or an epic
 * reassignment) for the epic the card left. It no-ops unless the epic exists,
 * is autonomous, and now has zero linked cards — so it never disarms a
 * freshly-created empty epic the operator is still populating, because such an
 * epic never sees a card-removal event in the first place.
 *
 * Returns true when it actually flipped autonomous off.
 */
export function disableAutonomousForEmptyEpic(
  deps: DisableAutonomousDeps,
  projectId: string,
  epicId: string | null | undefined,
): boolean {
  if (!epicId) return false;
  const epic = deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
  if (!epic || !epic.autonomous) return false;

  const cards = deps.stmts.getKanbanCardsByEpic.all(epicId) as KanbanCardRow[];
  if (cards.length > 0) return false;

  // Flip only `autonomous`; preserve every other setting (send-it,
  // enabled-by, model, budgets, base branch) exactly as the all-done disarm
  // path does, so re-arming later keeps the operator's configuration.
  deps.stmts.updateKanbanEpic.run(
    epic.name,
    epic.description,
    epic.color,
    0,
    epic.autonomous_interval,
    epic.autonomous_max_concurrent,
    epic.autonomous_model ?? null,
    epic.orchestration_budgets_json ?? null,
    epic.pr_base_branch ?? null,
    epic.labels ?? null,
    epic.id,
  );
  const clearedEpic = deps.stmts.getKanbanEpic.get(epic.id) as KanbanEpicRow;
  deps.scheduleAutonomousEpic(projectId, clearedEpic);
  deps.broadcast({ type: 'kanban_update', projectId });
  console.log(`[Autonomous] epic "${epic.name}" has no cards left; autonomous mode disabled`);
  return true;
}
