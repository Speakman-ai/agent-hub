/**
 * Conversational authoring for a QA plan: the seed message that opens the
 * plan's QA session, and the lookups that feed it.
 *
 * The seed carries the plan id, target, goal, and the linked epic / card
 * descriptions (which hold their acceptance criteria), so the QA agent can
 * propose cases without the user restating any of it.
 */
import { getDb } from './db.js';
import { QA_AGENT_ROLE } from './qa-agent-prompt.js';
import type { Agent, Project, QaPlanRow } from './types.js';

/** Long epic / card descriptions are cut so the seed stays a reasonable size. */
export const MAX_LINKED_DESCRIPTION_CHARS = 6_000;

export interface QaAuthoringLinkedEpic {
  id: string;
  name: string;
  description: string | null;
}

export interface QaAuthoringLinkedCard {
  id: string;
  shortId: number | null;
  title: string;
  description: string | null;
}

export interface QaAuthoringContext {
  epic: QaAuthoringLinkedEpic | null;
  card: QaAuthoringLinkedCard | null;
}

function clip(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_LINKED_DESCRIPTION_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_LINKED_DESCRIPTION_CHARS).trimEnd()}\n\n[truncated]`;
}

function descriptionBlock(description: string | null): string {
  const text = description?.trim();
  return text ? clip(text) : '_No description._';
}

/** The first user turn of a plan's authoring session. Pure. */
export function buildQaAuthoringSeed(args: {
  project: Pick<Project, 'id' | 'name'>;
  plan: Pick<QaPlanRow, 'id' | 'title' | 'goal' | 'target_url'>;
  context: QaAuthoringContext;
}): string {
  const { project, plan, context } = args;
  const lines = [
    `[QA plan] ${plan.title}`,
    '',
    `Draft test cases for QA plan \`${plan.id}\` in project \`${project.id}\` with me.`,
    '',
    `- **Target URL:** ${plan.target_url}`,
    `- **Goal:** ${plan.goal.trim() || '_None given. Ask me what this plan should prove._'}`,
  ];
  if (context.epic) {
    lines.push(
      '',
      `### Linked epic: ${context.epic.name} (\`${context.epic.id}\`)`,
      '',
      descriptionBlock(context.epic.description),
    );
  }
  if (context.card) {
    const ref = context.card.shortId != null ? `#${context.card.shortId}` : context.card.id;
    lines.push(
      '',
      `### Linked card ${ref}: ${context.card.title} (\`${context.card.id}\`)`,
      '',
      descriptionBlock(context.card.description),
    );
  }
  lines.push(
    '',
    '### What to do',
    '',
    `1. Run \`qa.sh plan get ${plan.id}\` to see any cases that already exist.`,
    `2. Propose cases grounded in the goal${context.epic || context.card ? ' and the acceptance criteria above' : ''}, and add them with \`qa.sh case add ${plan.id}\` in run order. One behavior per case, numbered steps, an observable expected result.`,
    '3. Summarize the list here and ask what to change. Apply my edits with `qa.sh case update` / `case delete` / `case reorder`; I may also edit cases directly on the plan page.',
    '4. When the list looks right, tell me it is ready and that I approve it with **Approve** on the plan page. Do not start a run.',
  );
  return lines.join('\n');
}

/** Linked epic / card rows for the seed. Missing links resolve to null. */
export function loadQaAuthoringContext(
  plan: Pick<QaPlanRow, 'epic_id' | 'card_id'>,
): QaAuthoringContext {
  const db = getDb();
  const epic = plan.epic_id
    ? (db
        .prepare('SELECT id, name, description FROM kanban_epics WHERE id = ?')
        .get(plan.epic_id) as QaAuthoringLinkedEpic | undefined)
    : undefined;
  const card = plan.card_id
    ? (db
        .prepare(
          'SELECT id, short_id AS shortId, title, description FROM kanban_cards WHERE id = ?',
        )
        .get(plan.card_id) as QaAuthoringLinkedCard | undefined)
    : undefined;
  return { epic: epic ?? null, card: card ?? null };
}

/** The project's QA agent, or null when it was never seeded or was deleted. */
export function findProjectQaAgent(project: Pick<Project, 'agents'>): Agent | null {
  return (project.agents ?? []).find((a) => a.role === QA_AGENT_ROLE) ?? null;
}
