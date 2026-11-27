/** Broadcast when an epic manager holds a card it cannot move without a person. */
export const EPIC_MANAGER_STALLED_EVENT = 'epic_manager_stalled';

/** Card label the manager (or a person) sets to hold a card out of the ready set. */
export const EPIC_MANAGER_HOLD_LABEL = 'hold';

export function hasHoldLabel(labels: string | null | undefined): boolean {
  if (!labels) return false;
  return labels
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .includes(EPIC_MANAGER_HOLD_LABEL);
}
