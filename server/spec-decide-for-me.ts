/**
 * "Decide for me" — research a spec decision in a scoping session (no kanban spike ticket).
 */
import type { KanbanEpicSpecItemRow, Project } from './types.js';
import { pickLead } from './routing.js';

/** First-message context when the operator clicks "Decide for me" on a spec item. */
export function buildDecideForMeSessionContext(args: {
  specItem: KanbanEpicSpecItemRow;
  projectId: string;
  projectName?: string;
}): string {
  const { specItem, projectId, projectName } = args;
  const lines = [
    `# Spec decision: ${specItem.tag} — ${specItem.title}`,
    '',
    'The operator asked you to **decide for them**. Research the trade-offs, pick an approach, and lock it on the epic.',
    '',
    `**Spec item:** \`${specItem.id}\` · tag \`${specItem.tag}\``,
    projectName ? `**Project:** ${projectName}` : '',
    specItem.decision?.trim()
      ? `\n## Current draft\n${specItem.decision.trim()}`
      : '\n_No decision recorded yet._',
    '',
    '## Hard constraints',
    '',
    '- **No code** — do not edit files, open PRs, run Finalize, or ship anything.',
    '- **Planning only** — output is a locked spec decision on the epic, not implementation work.',
    '',
    '## Your deliverable',
    '',
    '1. Investigate trade-offs (wiki search, codebase read-only review, web search if helpful).',
    '2. Lock the decision via the board API using this structure in the `decision` field:',
    '',
    '```',
    '## Decision',
    '<One clear, actionable choice>',
    '',
    '## Rationale',
    '<Why this option — tradeoffs, risks, and context so humans and implementation agents understand>',
    '```',
    '',
    '```',
    `PUT /api/projects/${projectId}/board/spec-items/${specItem.id}`,
    '{ "decision": "## Decision\\n...\\n\\n## Rationale\\n...", "status": "chosen" }',
    '```',
    '',
    '3. Do **not** create kanban tickets for this work — the spec item on the epic **is** the record.',
  ].filter(Boolean);
  return lines.join('\n');
}

/** Default agent for decide-for-me: project lead, else first non-reviewer dev. */
export function pickDefaultDecideAgent(project: Project): { id: string; name: string } | null {
  const lead = pickLead(project);
  if (lead) return { id: lead.id, name: lead.name };

  const fallback = project.agents.find(
    (a) => a.role !== 'reviewer' && a.role !== 'docs' && a.role !== 'intake',
  );
  if (fallback) return { id: fallback.id, name: fallback.name };

  const resolved = project.agents[0];
  return resolved ? { id: resolved.id, name: resolved.name } : null;
}
