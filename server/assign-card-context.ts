import type { KanbanCardRow } from './types.js';

/**
 * First-message context for a standard (non-spike) card assignment. The agent
 * is told the card already exists and how to comment/move/update it. We do
 * **not** encourage spawning follow-up child cards here: for the small features
 * and bugs that make up most assignments, splitting work into extra tickets is
 * noise we want to avoid, so the assigned card stays the single ticket.
 */
export function buildAssignedCardSessionContext(args: {
  card: KanbanCardRow;
  projectId: string;
  assignmentNote?: string;
  replayContext?: string | null;
}): string {
  const { card, projectId, assignmentNote, replayContext } = args;
  const lines: string[] = [`# Task: ${card.title}`];
  if (card.description) lines.push(`\n## Description\n${card.description}`);
  if (card.priority) lines.push(`\n**Priority:** ${card.priority}`);
  if (card.labels) lines.push(`**Labels:** ${card.labels}`);
  if (card.github_issue_url) lines.push(`**GitHub:** ${card.github_issue_url}`);
  if (assignmentNote) lines.push(`\n## Assignment Note\n${assignmentNote}`);
  if (replayContext) lines.push(`\n${replayContext}`);

  lines.push(
    `\n---`,
    `You have been assigned this task from the project kanban board. Review the description above and begin working on it.`,
    ``,
    `**This session is already linked to kanban card \`${card.id}\`.** Do **NOT** create a new card for this work — the card already exists and tracks your progress. The "Bias to Action — create a card" guidance in your system prompt does not apply here. Instead:`,
    `- **Comment** on this card to record findings, blockers, or PR links: \`POST /api/projects/${projectId}/board/cards/${card.id}/comments\``,
    `- **Move** this card to In Progress when you start: \`POST /api/projects/${projectId}/board/cards/${card.id}/move\`. Do **not** move it to Done yourself — Done means merged, and the platform closes the card automatically when your change lands.`,
    `- **Update** title/description/labels in place: \`PUT /api/projects/${projectId}/board/cards/${card.id}\``,
  );

  return lines.join('\n');
}
