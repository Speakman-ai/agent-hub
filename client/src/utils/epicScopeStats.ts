/** Shared stats/helpers for epic scope UI (flowchart, manage list, spec). */

export function columnNameById(columns: any[]): Record<string, string> {
  return Object.fromEntries((columns || []).map((c: any) => [c.id, c.name]));
}

export function isColumnDone(name: string): boolean {
  return String(name || '').toLowerCase() === 'done';
}

/**
 * A card in a "Canceled" / "Cancelled" column is dropped work, not a live epic
 * ticket. Cancelled tickets must not appear anywhere in the epic scope UI
 * (counts, unassigned list, phase columns, progress). Matches both spellings on
 * a word boundary so custom names like "Won't do / Cancelled" still qualify
 * without misclassifying unrelated columns.
 */
export function isColumnCancelled(name: string): boolean {
  return /\bcancell?ed\b/i.test(String(name || '').trim());
}

/**
 * Tickets belonging to an epic. When `columns` is supplied, cards sitting in a
 * cancelled column are excluded so cancelled work never surfaces in the epic.
 */
export function ticketsForEpic(cards: any[], epicId: string, columns?: any[]) {
  const nameById = columns ? columnNameById(columns) : null;
  return (cards || []).filter((c: any) => {
    if (c.epic_id !== epicId) return false;
    if (nameById && isColumnCancelled(nameById[c.column_id] || '')) return false;
    return true;
  });
}

export function phasesForEpic(phases: any[], epicId: string) {
  return (phases || [])
    .filter((p: any) => p.epic_id === epicId)
    .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
}

export function ticketsForPhase(cards: any[], phaseId: string) {
  return (cards || []).filter((c: any) => c.phase_id === phaseId);
}

export function countDoneTickets(tickets: any[], columnNameById: Record<string, string>) {
  return tickets.filter((t) => isColumnDone(columnNameById[t.column_id] || '')).length;
}

export function phaseProgress(tickets: any[], columnNameById: Record<string, string>) {
  if (tickets.length === 0) return 0;
  return Math.round((countDoneTickets(tickets, columnNameById) / tickets.length) * 100);
}

/**
 * A phase is "complete" when it has at least one ticket and every ticket is in
 * the Done column. An empty phase is never complete (nothing was finished yet).
 */
export function phaseComplete(tickets: any[], columnNameById: Record<string, string>) {
  return tickets.length > 0 && countDoneTickets(tickets, columnNameById) === tickets.length;
}

export function epicAutonomousSummary(phases: any[]) {
  const autoCount = phases.filter((p) => p.autonomous === 1).length;
  if (phases.length === 0) return { label: null, autoCount: 0, total: 0 };
  if (autoCount === phases.length) return { label: 'ALL AUTO', autoCount, total: phases.length };
  if (autoCount > 0) return { label: `${autoCount} AUTO`, autoCount, total: phases.length };
  return { label: null, autoCount: 0, total: phases.length };
}

/** Spec decision progress for an epic — drives the spec-first epic page layout. */
export function specProgress(specItems: any[]) {
  const total = specItems.length;
  const chosen = specItems.filter((s) => s.status === 'chosen').length;
  const open = specItems.filter((s) => s.status === 'open').length;
  const deferred = specItems.filter((s) => s.status === 'deferred').length;
  const pct = total > 0 ? Math.round((chosen / total) * 100) : 0;
  const readyForImplementation = total > 0 && open === 0;
  return { total, chosen, open, deferred, pct, readyForImplementation };
}

export function ticketHasBlockers(ticket: any) {
  return (ticket.blockers || []).some((b: any) => !b.done);
}

export function columnStatusStyle(columnName: string) {
  const n = columnName.toLowerCase();
  if (n === 'done') return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/25';
  if (n === 'in progress') return 'bg-sky-500/15 text-sky-300 ring-sky-500/25';
  if (n === 'review') return 'bg-amber-500/15 text-amber-300 ring-amber-500/25';
  return 'bg-white/[0.06] text-gray-400 ring-white/10';
}

export function columnDotStyle(columnName: string) {
  const n = columnName.toLowerCase();
  if (n === 'done') return 'bg-emerald-400';
  if (n === 'in progress') return 'bg-sky-400';
  if (n === 'review') return 'bg-amber-400';
  return 'bg-gray-500';
}

export function priorityStyle(priority: string) {
  const map: Record<string, string> = {
    urgent: 'text-red-300',
    high: 'text-orange-300',
    medium: 'text-sky-300',
    low: 'text-gray-400',
  };
  return map[priority] || map.medium;
}
