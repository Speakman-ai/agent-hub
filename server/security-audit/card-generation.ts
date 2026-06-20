/**
 * card-generation.ts — turn newly-discovered vulnerable dependencies into a
 * single kanban card so the operator (or autonomous dispatch) can action
 * the bumps.
 *
 * "(or kanban cards)" in the acceptance criteria: rather than auto-opening a
 * PR with a lockfile bump (a heavier, riskier follow-up), the first cut
 * surfaces findings as a board card. One card per scan summarises every
 * *new* open finding, titled with the severity breakdown and bodied with a
 * per-package checklist including the suggested fixed version.
 *
 * Idempotency lives upstream: the store only returns findings persisted as
 * `open` for the first time this scan, so a re-scan with no new vulns calls
 * this with an empty list and no card is created.
 */

import { v4 as uuidv4 } from 'uuid';
import type { BroadcastFn, KanbanCardRow, KanbanColumnRow, Stmts } from '../types.js';
import { getOrCreateBoard } from '../routes/board.js';
import type { SecurityFindingRow } from './findings-store.js';
import { severityRank } from './severity.js';
import type { Severity } from './types.js';

export interface SecurityCardDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown'];

/** Map worst severity in the batch to a card priority. */
function priorityForSeverity(worst: Severity): 'high' | 'medium' | 'low' {
  if (worst === 'critical' || worst === 'high') return 'high';
  if (worst === 'medium') return 'medium';
  return 'low';
}

/** Prefer a "To Do" column so the card is actionable, not mid-flight. */
function resolveTodoColumnId(columns: KanbanColumnRow[]): string {
  const todo = columns.find((c) => c.name.toLowerCase() === 'to do');
  if (todo) return todo.id;
  const sorted = [...columns].sort((a, b) => a.position - b.position);
  if (!sorted[0]) throw new Error('Board has no columns');
  return sorted[0].id;
}

export function buildSecurityCardContent(findings: SecurityFindingRow[]): {
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
} {
  const counts = new Map<Severity, number>();
  let worst: Severity = 'unknown';
  for (const f of findings) {
    counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
    if (severityRank(f.severity) > severityRank(worst)) worst = f.severity;
  }
  const breakdown = SEVERITY_ORDER.filter((s) => counts.get(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(', ');

  const noun = findings.length === 1 ? 'vulnerable dependency' : 'vulnerable dependencies';
  const title = `[security] ${findings.length} ${noun}${breakdown ? ` (${breakdown})` : ''}`;

  const lines: string[] = [
    '## Vulnerable dependencies detected',
    '',
    'Automated dependency audit found the following advisories. Bump each package to its fixed version (or dismiss the finding if not applicable).',
    '',
  ];
  const sorted = [...findings].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.package_name.localeCompare(b.package_name),
  );
  for (const f of sorted) {
    const fix = f.fixed_version ? ` → bump to \`${f.fixed_version}\`` : ' (no fix published)';
    const ref = f.advisory_url ? ` ([${f.advisory_id}](${f.advisory_url}))` : ` (${f.advisory_id})`;
    const where = f.manifest_path ? ` in \`${f.manifest_path}\`` : '';
    lines.push(
      `- [ ] **${f.severity.toUpperCase()}** \`${f.package_name}@${f.package_version}\`${fix}${where} — ${f.summary}${ref}`,
    );
  }

  return { title, description: lines.join('\n'), priority: priorityForSeverity(worst) };
}

export interface GenerateSecurityCardResult {
  card: KanbanCardRow | null;
  created: boolean;
}

/**
 * Create one kanban card summarising `newFindings`. No-op (returns
 * `{card: null, created: false}`) when there are no new findings.
 */
export function generateSecurityCard(
  deps: SecurityCardDeps,
  args: { projectId: string; newFindings: SecurityFindingRow[]; createdBy?: string | null },
): GenerateSecurityCardResult {
  if (args.newFindings.length === 0) return { card: null, created: false };

  const { board, columns } = getOrCreateBoard(deps.stmts, args.projectId);
  const columnId = resolveTodoColumnId(columns);
  const existingCards = deps.stmts.getKanbanCardsByColumn.all(columnId) as KanbanCardRow[];
  const position =
    existingCards.length > 0 ? Math.max(...existingCards.map((c) => c.position)) + 1 : 0;

  const { title, description, priority } = buildSecurityCardContent(args.newFindings);
  const id = uuidv4();

  deps.stmts.createKanbanCard.run(
    id,
    columnId,
    board.id,
    title,
    description,
    priority,
    null, // assignee
    'security,dependencies', // labels
    null, // session_id
    null, // github_issue_url
    args.createdBy ?? null,
    null, // assign_model
    position,
  );

  const card = deps.stmts.getKanbanCard.get(id) as KanbanCardRow;
  deps.broadcast({ type: 'kanban_update', projectId: args.projectId });
  return { card, created: true };
}
