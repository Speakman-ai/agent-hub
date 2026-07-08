// Group epics into the three lifecycle columns for the epics board view.
// Epic `state` is computed server-side (see server/epic-state.ts): 'not_started',
// 'in_progress', 'done', or null when the epic has no cards yet. An epic with no
// state (empty) belongs under "Not started" since no work has begun.

import { EPIC_STATE_LABELS, type EpicLifecycleState } from './epics';

export type EpicBoardColumnKey = EpicLifecycleState;

export type EpicBoardColumn<T> = {
  key: EpicBoardColumnKey;
  label: string;
  epics: T[];
};

export const EPIC_BOARD_COLUMN_ORDER: EpicBoardColumnKey[] = ['not_started', 'in_progress', 'done'];

/** Bucket an epic's raw state into one of the three board columns. */
export function epicBoardColumnKey(state: string | null | undefined): EpicBoardColumnKey {
  if (state === 'in_progress') return 'in_progress';
  if (state === 'done') return 'done';
  // null / 'not_started' / anything unexpected -> Not started
  return 'not_started';
}

/** Split epics into ordered board columns, preserving input order within each. */
export function groupEpicsByState<T extends { state?: string | null }>(
  epics: T[],
): EpicBoardColumn<T>[] {
  const buckets: Record<EpicBoardColumnKey, T[]> = {
    not_started: [],
    in_progress: [],
    done: [],
  };
  for (const epic of epics || []) {
    buckets[epicBoardColumnKey(epic.state)].push(epic);
  }
  return EPIC_BOARD_COLUMN_ORDER.map((key) => ({
    key,
    label: EPIC_STATE_LABELS[key],
    epics: buckets[key],
  }));
}
