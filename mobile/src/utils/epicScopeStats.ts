// Pure stats/helpers for the mobile epic detail (workbench) screen.
// Mirrors the pure functions in client/src/utils/epicScopeStats.ts so web and
// mobile agree on ticket/spec/phase progress. The web file also carries
// Tailwind-class helpers (columnStatusStyle, priorityStyle, …) that are
// web-only styling — those are intentionally omitted here; mobile styles come
// from the theme palette instead.

export function columnNameById(columns: any[]): Record<string, string> {
  return Object.fromEntries((columns || []).map((c: any) => [c.id, c.name]));
}

export function isColumnDone(name: string): boolean {
  return String(name || '').toLowerCase() === 'done';
}

export function ticketsForEpic(cards: any[], epicId: string) {
  return (cards || []).filter((c: any) => c.epic_id === epicId);
}

export function phasesForEpic(phases: any[], epicId: string) {
  return (phases || [])
    .filter((p: any) => p.epic_id === epicId)
    .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
}

export function ticketsForPhase(cards: any[], phaseId: string) {
  return (cards || []).filter((c: any) => c.phase_id === phaseId);
}

export function countDoneTickets(tickets: any[], colMap: Record<string, string>) {
  return (tickets || []).filter((t) => isColumnDone(colMap[t.column_id] || '')).length;
}

export function phaseProgress(tickets: any[], colMap: Record<string, string>) {
  if (!tickets || tickets.length === 0) return 0;
  return Math.round((countDoneTickets(tickets, colMap) / tickets.length) * 100);
}

/**
 * A phase is "complete" when it has at least one ticket and every ticket is in
 * the Done column. An empty phase is never complete (nothing was finished yet).
 */
export function phaseComplete(tickets: any[], colMap: Record<string, string>) {
  return !!tickets && tickets.length > 0 && countDoneTickets(tickets, colMap) === tickets.length;
}

export function epicAutonomousSummary(phases: any[]) {
  const list = phases || [];
  const autoCount = list.filter((p) => p.autonomous === 1).length;
  if (list.length === 0) return { label: null, autoCount: 0, total: 0 };
  if (autoCount === list.length) return { label: 'ALL AUTO', autoCount, total: list.length };
  if (autoCount > 0) return { label: `${autoCount} AUTO`, autoCount, total: list.length };
  return { label: null, autoCount: 0, total: list.length };
}

/**
 * Normalize a spec item's status to one of the three canonical buckets.
 * Anything that isn't the literal `'chosen'`/`'deferred'` (including
 * missing/null/unknown values) is treated as `'open'` — an undecided item.
 * `specProgress` and `specStatusLabel` both route through this so the count
 * that gates autonomous runs and the badge shown in the UI never disagree.
 */
export function normalizeSpecStatus(
  status: string | null | undefined,
): 'open' | 'chosen' | 'deferred' {
  const s = String(status || '').toLowerCase();
  if (s === 'chosen') return 'chosen';
  if (s === 'deferred') return 'deferred';
  return 'open';
}

/** Spec decision progress for an epic — drives the spec-first epic layout. */
export function specProgress(specItems: any[]) {
  const list = specItems || [];
  const total = list.length;
  const chosen = list.filter((s) => normalizeSpecStatus(s.status) === 'chosen').length;
  const open = list.filter((s) => normalizeSpecStatus(s.status) === 'open').length;
  const deferred = list.filter((s) => normalizeSpecStatus(s.status) === 'deferred').length;
  const pct = total > 0 ? Math.round((chosen / total) * 100) : 0;
  const readyForImplementation = total > 0 && open === 0;
  return { total, chosen, open, deferred, pct, readyForImplementation };
}

/** Spec item status → mobile label. */
export const SPEC_STATUS_LABELS: Record<'open' | 'chosen' | 'deferred', string> = {
  open: 'Open',
  chosen: 'Locked',
  deferred: 'Deferred',
};

export function specStatusLabel(status: string | null | undefined): string {
  return SPEC_STATUS_LABELS[normalizeSpecStatus(status)];
}
