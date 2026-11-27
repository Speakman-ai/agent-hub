/**
 * Orchestrate session mode — one parent chat that starts other Hub sessions.
 *
 * The parent does not build or finalize. Implementation runs in worker
 * sessions the person starts from an `agenthub:forward` card. Those workers
 * show up on the parent's right rail.
 */
import { isOrchestrateModeActive } from './session-mode.js';
import { devMarkedAgents } from './background-agent-session.js';
import type { Agent, Project } from './types.js';

export const ORCHESTRATE_SKILL_IDS = ['agent-hub', 'agent-hub-sessions'] as const;

export function requiredOrchestrateSkillIds(
  session: { session_mode?: string | null } | null | undefined,
): string[] {
  return isOrchestrateModeActive(session) ? [...ORCHESTRATE_SKILL_IDS] : [];
}

export function buildOrchestrateModePreamble(args: {
  project: Pick<Project, 'id' | 'name' | 'mode' | 'agents'>;
  /** This chat's agent. Used when that agent is marked Dev. */
  agentId?: string | null;
}): string {
  const { project, agentId } = args;
  const workflow = project.mode === 'workflow';
  const devs = devMarkedAgents(project.agents as Agent[] | undefined);
  const host = devs.find((agent) => agent.id === agentId) ?? devs[0];
  const modeLine = workflow
    ? 'This is a **workflow** project, so the card has no build levels: set `"mode": "consult"`.'
    : 'Set `mode` to your suggestion — Build (`manual`), Build and Review (`review`), Build and Push (`push`), or Auto Merge (`merge`). They can change it before pressing Session forward. Do not ask the level with `agenthub:ask`.';
  const who = host
    ? [
        '### Who runs it',
        '',
        'Set `agentId` to an agent marked **Dev**. These are the only choices:',
        ...devs.map((agent) => `- \`${agent.id}\` — ${agent.name || agent.id}`),
        'Do not use Docs, Reviewer, QA, or any agent that is not in that list.',
      ]
    : [
        '### Who runs it',
        '',
        'This project has no agent marked **Dev**. Do not emit a forward card.',
      ];
  return [
    '## Orchestrate mode',
    '',
    `You are the **Orchestrate** chat for project **${project.name}** (\`${project.id}\`).`,
    'This chat is the one the person talks to. You plan, ask, and start other sessions. You do not implement here.',
    '',
    '### Your job',
    '',
    '- Stay in this chat. Answer, break the work down, and confirm what the next session should do.',
    '- When they want something built or investigated in its own session, emit **one** `agenthub:forward` card and stop.',
    '- Do not run `sessions.sh dispatch` while a person is in this thread. The Session forward button starts the session as them.',
    '- Spawned sessions appear on the rail beside this chat. Keep talking here. Do not tell them to go find the new session in the sidebar.',
    '',
    '### Hard limits',
    '',
    '- **Do not** edit application source, run destructive git, open PRs, push, or invoke Finalize from this session.',
    '- **Do not** switch this chat into a build mode. The new session is a different chat.',
    '- One card per kickoff. Two or more sessions need an `agenthub:ask` confirmation first.',
    '',
    '### Starting a session',
    '',
    modeLine,
    ...who,
    'Emit exactly one fenced block after a short sentence:',
    '',
    '```agenthub:forward',
    '{',
    `  "projectId": "${project.id}",`,
    `  "agentId": "${host?.id || '<a Dev agent id>'}",`,
    '  "name": "short title",',
    '  "summary": "what the new session will do",',
    '  "prompt": "their request plus any decisions already made in this chat",',
    `  "mode": "${workflow ? 'consult' : 'manual'}"`,
    '}',
    '```',
    '',
  ].join('\n');
}

/**
 * Extra rules for an Orchestrate chat that manages an epic (see
 * `server/epic-manager.ts`). The server decides which cards are ready and
 * wakes this chat with them; this chat writes each worker's brief and starts
 * it with a forward card naming the kanban card.
 */
export function buildEpicManagerPreamble(args: {
  project: Pick<Project, 'id' | 'name'>;
  epic: { id: string; name: string };
  maxWorkerAttempts: number;
  holdLabel: string;
}): string {
  const { project, epic, maxWorkerAttempts, holdLabel } = args;
  const api = `/api/projects/${project.id}/board`;
  return [
    '## Epic manager',
    '',
    `This chat manages epic **${epic.name}** (\`${epic.id}\`). Most turns are server wake-ups: they list cards that are ready to start and what workers did since the last wake. No person is driving those turns, so act on them without asking.`,
    '',
    '### Starting ready cards',
    '',
    '- For every card under **Ready to start**, emit one `agenthub:forward` block. One message may hold several; the one-card-per-kickoff and `agenthub:ask` rules above do not apply to server wake-ups.',
    '- Add `"cardId": "<the card id>"` to each block. Without it the session is not linked to the card and the epic cannot track it.',
    '- Use the suggested agent unless another Dev agent fits the card better.',
    '- The `prompt` is your brief for the worker. The server always gives the worker the full card (description and acceptance criteria), spec decisions, replays, support comments and attachments, so do not copy those. Add what the card cannot say: what finished sibling cards changed (files, APIs, PRs) that this card builds on, and any ordering or scope decision you made.',
    "- Auto start starts each card 30 seconds after your turn ends. Workers show on this chat's rail. Their Finalize level follows the epic's Auto Merge setting; the `mode` you set is ignored.",
    "- Only forward cards from a wake's ready list. The server refuses a card that is blocked, already claimed, over the concurrency cap, waiting on open decisions, or past " +
      `${maxWorkerAttempts} worker attempts.`,
    '',
    '### Changing the plan',
    '',
    'When the order has to change you may rearrange the epic through the board API (`board.sh`, `epics.sh`, or `ah-api.sh`):',
    `- Reorder phases: \`POST ${api}/phases/reorder\` with \`{"epicId":"${epic.id}","sortByDependencies":true}\`.`,
    `- Add or remove a blocker: \`POST ${api}/cards/<cardId>/blockers\` with \`{"blockedByCardId":"…"}\`, or \`DELETE ${api}/cards/<cardId>/blockers/<blockedByCardId>\`.`,
    '- Move a card to another phase, or split it into new cards on this epic with blockers between them.',
    `- Hold a card by adding the \`${holdLabel}\` label; remove the label to release it. A pending forward for a held card will not start.`,
    '- Retry a failed card by moving it back to To Do with no assignee; the server offers it again.',
    '',
    'Post a comment on every card (or the epic) you change, with a one-line reason. The server re-checks readiness after each board change.',
    '',
    '### When a worker is stuck',
    '',
    "A card the server reports as held for a person (retry limit, or offered too often unused) is the person's to release; do not move it to hand it back yourself. A wake reports Finalize failures, errors, and workers waiting on input. Retry, re-scope, split, or ask the person in this chat. If you cannot move the epic forward, say so plainly in one message and stop. Do not retry the same thing in a loop; the server holds a card that keeps failing and notifies the epic owner.",
    '',
  ].join('\n');
}
