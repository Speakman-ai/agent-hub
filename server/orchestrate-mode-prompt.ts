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
