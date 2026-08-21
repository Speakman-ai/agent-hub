/**
 * Sectioning + pagination for the cross-project support overview.
 *
 * The overview endpoint (`GET /api/support-tickets`) returns every project's
 * support tickets in one severity-ordered list plus a `projects` option set
 * (already ordered by descending ticket count, then name). The overview page
 * groups those tickets into per-project sections and paginates each section on
 * the client so a busy project can't run its list all the way down the page.
 * This logic is pure so web and mobile share it (and one test covers both).
 */

export type SupportSeverity = 'critical' | 'high' | 'medium' | 'low';

const SEVERITIES: readonly SupportSeverity[] = ['critical', 'high', 'medium', 'low'];

export interface OverviewTicketLike {
  id: string;
  project_id: string;
  project_name?: string | null;
  severity?: string | null;
}

export interface ProjectOption {
  id: string;
  name: string;
  count: number;
}

export interface ProjectSection<T extends OverviewTicketLike = OverviewTicketLike> {
  id: string;
  name: string;
  tickets: T[];
  /** Per-severity tally of the tickets in THIS filtered section. */
  severityCounts: Record<SupportSeverity, number>;
}

function emptySeverityCounts(): Record<SupportSeverity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

function isSeverity(v: unknown): v is SupportSeverity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v);
}

/**
 * Group the (already-filtered) ticket list into per-project sections.
 *
 * Section order follows the `projects` option set — the server sorts it by
 * descending total ticket count, then name — so the busiest projects lead.
 * Projects that have no tickets in the current filtered set are omitted (an
 * empty section is noise). A ticket whose project is missing from `projects`
 * (shouldn't happen, but the payloads are loosely typed) still gets a section,
 * appended after the known ones in first-seen order, named from its own
 * `project_name`.
 */
export function groupTicketsByProject<T extends OverviewTicketLike>(
  tickets: readonly T[],
  projects: readonly ProjectOption[],
): ProjectSection<T>[] {
  const byProject = new Map<string, T[]>();
  const firstSeen: string[] = [];
  for (const t of tickets) {
    let bucket = byProject.get(t.project_id);
    if (!bucket) {
      bucket = [];
      byProject.set(t.project_id, bucket);
      firstSeen.push(t.project_id);
    }
    bucket.push(t);
  }

  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const ordered: string[] = [];
  const seen = new Set<string>();
  // Known projects first, in option order…
  for (const p of projects) {
    if (byProject.has(p.id) && !seen.has(p.id)) {
      ordered.push(p.id);
      seen.add(p.id);
    }
  }
  // …then any stragglers not present in the option set, first-seen order.
  for (const id of firstSeen) {
    if (!seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }

  return ordered.map((id) => {
    const sectionTickets = byProject.get(id) ?? [];
    const severityCounts = emptySeverityCounts();
    for (const t of sectionTickets) {
      if (isSeverity(t.severity)) severityCounts[t.severity] += 1;
    }
    const name = nameById.get(id) ?? sectionTickets[0]?.project_name ?? id;
    return { id, name, tickets: sectionTickets, severityCounts };
  });
}

/** Total number of pages for `total` items at `pageSize` (>= 1). */
export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Clamp a (1-based) page into the valid range for the given item count. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const last = pageCount(total, pageSize);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.floor(page)), last);
}

/** The slice of `items` for a 1-based `page` at `pageSize` (clamped). */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): T[] {
  if (pageSize <= 0) return [...items];
  const safePage = clampPage(page, items.length, pageSize);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
