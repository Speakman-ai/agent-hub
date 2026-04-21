/**
 * Pure helpers for the mobile DashboardScreen.
 *
 * The screen itself is a thin RN view over these — keeping the data
 * shaping in plain JS means we can unit-test the mobile dashboard via
 * `vitest` (which only runs `src/utils/`) without booting the RN
 * environment.
 */

export const HEADLINE_TILES = [
  { key: 'projects', label: 'Projects' },
  { key: 'agents', label: 'Agents' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'activeSessions', label: 'Active sessions' },
  { key: 'openCards', label: 'Open cards' },
  { key: 'openPRs', label: 'Open PRs' },
  { key: 'escalations', label: 'Escalations' },
];

export const PRIORITY_KEYS = ['urgent', 'high', 'medium', 'low'];

export const ACTIVITY_LABELS = {
  card_created: 'Card created',
  card_updated: 'Card updated',
  session_created: 'Session started',
  escalation: 'Escalation',
  pr_created: 'PR opened',
};

/**
 * Map the dashboard headline payload to a list of `{ key, label, value }`
 * tuples in the canonical display order. Missing keys default to 0 so the
 * UI never renders `undefined`.
 */
export function formatHeadlineTiles(headline = {}) {
  return HEADLINE_TILES.map(({ key, label }) => ({
    key,
    label,
    value: Number(headline?.[key] ?? 0),
  }));
}

/**
 * Convert the priority bucket map to a list of `{ key, count, percent }`
 * rows in canonical priority order. `percent` is the row's share of the
 * largest bucket, scaled 0..100, so the screen can render proportional
 * bars without recomputing the max each frame.
 */
export function priorityRows(byPriority = {}) {
  const max = Math.max(1, ...PRIORITY_KEYS.map((k) => Number(byPriority?.[k] ?? 0)));
  return PRIORITY_KEYS.map((key) => {
    const count = Number(byPriority?.[key] ?? 0);
    return {
      key,
      count,
      percent: Math.round((count / max) * 100),
    };
  });
}

/**
 * Same idea as `priorityRows` but for `kanban.byColumn`. Preserves the
 * server's column ordering and tags each row with its scaled `percent`.
 */
export function columnRows(byColumn = []) {
  const max = Math.max(1, ...byColumn.map((c) => Number(c?.count ?? 0)));
  return byColumn.map((row) => ({
    columnName: row.columnName,
    count: Number(row.count ?? 0),
    percent: Math.round((Number(row.count ?? 0) / max) * 100),
  }));
}

/** Look up a human label for an activity event type. */
export function activityLabel(type) {
  return ACTIVITY_LABELS[type] || 'Activity';
}
