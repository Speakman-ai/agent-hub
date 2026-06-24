/**
 * Scoping-mode system-prompt preamble — planning sessions that organize work
 * into Epics → Phases → Tickets on the kanban board.
 *
 * Scoping mode is read-only with respect to shipping: no Finalize, no PRs.
 * Decide-for-me / scoping sessions (linked spec items) lock architecture decisions
 * that workers inherit when picking up implementation tickets.
 */
import { isScopingModeActive } from './session-mode.js';
import type { KanbanEpicRow, KanbanEpicSpecItemRow, KanbanPhaseRow } from './types.js';

export const SCOPING_SKILL_ID = 'agent-hub-kanban';

/**
 * Skills force-loaded for scoping mode (see design-mode-prompt.ts rationale).
 */
export function requiredScopingSkillIds(
  session: { session_mode?: string | null } | null | undefined,
): string[] {
  return isScopingModeActive(session) ? [SCOPING_SKILL_ID] : [];
}

export function buildScopingModePreamble(args: {
  projectName: string;
  linkedEpic?: KanbanEpicRow | null;
  phases?: KanbanPhaseRow[];
  specItems?: KanbanEpicSpecItemRow[];
  linkedSpecItem?: KanbanEpicSpecItemRow | null;
  projectId?: string;
}): string {
  const { projectName, linkedEpic, phases = [], specItems = [], linkedSpecItem, projectId } = args;
  const epicLine = linkedEpic
    ? `You are scoping epic **${linkedEpic.name}** (\`${linkedEpic.id}\`).`
    : 'No epic is linked yet — create or select an epic first, then organize phases under it.';

  const phaseSummary =
    phases.length > 0
      ? phases.map((p, i) => `${i + 1}. **${p.name}** (\`${p.id}\`)`).join('\n')
      : '_No phases yet — create phases to group related tickets._';

  const openSpecs = specItems.filter((s) => s.status === 'open');
  const chosenSpecs = specItems.filter((s) => s.status === 'chosen' && (s.decision ?? '').trim());
  const specSummary =
    specItems.length > 0
      ? specItems
          .map((s) => {
            const session = s.resolved_session_id ? ` · session \`${s.resolved_session_id}\`` : '';
            return `- **${s.tag}** ${s.title} (\`${s.id}\`) — _${s.status}_${session}`;
          })
          .join('\n')
      : '_No spec decisions yet — add spec items before filing implementation tickets._';

  const lines = [
    '## Scoping mode',
    '',
    'You are in **Scoping** mode for project **' +
      projectName +
      '**. Plan and structure work — nothing ships from this session.',
    '',
    epicLine,
    '',
    '### Hierarchy contract',
    '',
    'Organize work as **Epic → Spec decisions → Phases → Tickets**:',
    '',
    '- **Epic** — the large initiative.',
    '- **Spec decision** — an architecture choice locked on the epic (write it yourself or use **Decide for me**) before implementation proceeds.',
    '- **Phase** — a focused run of a feature or module (subgroup within the epic).',
    '- **Ticket** — a kanban card in To Do, linked to the epic and its phase.',
    '',
    'Use **blockers** between tickets to express dependency order (not parent/child).',
    '',
    '### Spec decisions (real — not placeholders)',
    '',
    specSummary,
    '',
    'Create spec items with `POST /api/projects/' +
      (projectId || '{projectId}') +
      '/board/spec-items`. Lock open items with `PUT .../spec-items/:id` or start **Decide for me** (`POST .../decide-for-me`) to research and lock a recommendation.',
    '',
    '### Current phases',
    '',
    phaseSummary,
  ];

  if (linkedSpecItem) {
    lines.push(
      '',
      '### Active spec decision (this session)',
      '',
      `You are resolving spec item **${linkedSpecItem.title}** (\`${linkedSpecItem.id}\`, tag \`${linkedSpecItem.tag}\`).`,
      'Research trade-offs and lock the decision with `PUT .../board/spec-items/' +
        linkedSpecItem.id +
        '` → `{ "decision": "## Decision\\n...\\n\\n## Rationale\\n...", "status": "chosen" }`.',
      'That decision appears under **Spec decisions** on the epic — implementation tickets inherit it.',
      '**No code, no PRs, no Finalize.** Do not create kanban tickets for this work.',
    );
  } else if (openSpecs.length > 0) {
    lines.push(
      '',
      '### Open spec decisions',
      '',
      `${openSpecs.length} spec decision(s) still need to be locked before autonomous implementation should run on this epic.`,
    );
  }

  if (chosenSpecs.length > 0) {
    lines.push('', '### Locked decisions (workers inherit these)', '');
    for (const item of chosenSpecs) {
      lines.push(`**${item.tag}: ${item.title}**`, (item.decision ?? '').trim(), '');
    }
  }

  lines.push(
    '',
    '### Rules',
    '',
    '- Add spec decisions before creating implementation tickets when starting fresh.',
    '- Decide-for-me / scoping sessions are **research-only** — no code, no PRs. Output is a locked **spec decision** on the epic.',
    '- Every implementation ticket should belong to a phase when scoping an epic.',
    '- Phases can enable **autonomous dispatch** only after all spec items are `chosen`.',
    '- Prefer the bundled kanban scripts (`board.sh`, `epics.sh`) over raw curl.',
    '',
  );

  return lines.join('\n');
}
