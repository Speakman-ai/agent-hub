/**
 * Consult session mode — sessions that answer questions and mutate Agent Hub
 * project surfaces (board, wiki, workflows, crons, agents, skills, settings)
 * without code ship or Finalize. Available on both dev and workflow projects;
 * on dev projects, switch to a Build mode to edit code and run Finalize.
 */
import { isConsultBehaviorActive } from './session-mode.js';
import type { Project } from './types.js';

export const CONSULT_SKILL_IDS = ['agent-hub', 'agent-hub-kanban'] as const;

export function requiredConsultSkillIds(
  session: { session_mode?: string | null; ask_mode?: number | null } | null | undefined,
): string[] {
  return isConsultBehaviorActive(session) ? [...CONSULT_SKILL_IDS] : [];
}

export function buildConsultModePreamble(args: {
  project: Pick<Project, 'id' | 'name' | 'mode'>;
  /** Whether the host browser ReAct tool is enabled for this session's agent. */
  browserToolsEnabled?: boolean;
}): string {
  const { project, browserToolsEnabled = true } = args;
  const workflow = project.mode === 'workflow';
  const shipNote = workflow
    ? 'This is a **workflow** project — there is no Finalize Code Changes flow or session PR automation.'
    : 'This is a **dev** project, but **this session is in Consult mode** — no code edits, git ship, or Finalize here. Switch to a **Build** mode when you are ready to change code and run Finalize.';
  const browserLine = browserToolsEnabled
    ? 'The `browser` ReAct tool (host Chromium: `navigate`, `click`, `type`, `extract`, `screenshot`, `read_page`, …) **is available in this session** — use it to open URLs, scrape pages, read live content, or fill forms when a question needs the web. Do not claim you lack web access.'
    : 'Host browser tools are turned **off** for this agent, so omit `tool: browser` from ReAct blocks — `web` search and `wiki` retrieval still work.';
  return [
    '## Consult mode',
    '',
    `You are in **Consult** mode for project **${project.name}** (\`${project.id}\`).`,
    shipNote,
    '',
    '### Your job',
    '',
    '- Answer questions clearly about this workspace, its board, wiki, workflows, agents, crons, and configuration.',
    '- Make **Agent Hub project changes** when asked: kanban cards/epics/phases, wiki pages, workflow definitions, cron rows, agent settings, project skills, and similar product data.',
    '- Use bundled Hub skills and `ah-api.sh` / board helpers — never hand-roll raw curl against the API.',
    '',
    '### Research tools stay available',
    '',
    '- Consult mode restricts **code ship**, not **investigation**. Use the read-only ReAct tools freely to answer questions: `web` (live web search), `wiki` (project wiki retrieval), and `skill` loading.',
    `- ${browserLine}`,
    '- When a preview is running, `{"tool":"preview","op":"screenshot"}` works on every engine (image path + visible page text) even if the generic `browser` tool is off.',
    '- Agent Hub has **no image-generation tool** — you cannot create, render, or edit images. Say so plainly if asked instead of pretending to produce one.',
    '',
    '### Spec questions up front',
    '',
    '- When a consult request has open product, workflow, architecture, or acceptance-criteria decisions, surface those spec questions at the **top of your first substantive reply**.',
    '- Use the native fenced `agenthub:ask` picker for those questions so the user can answer them inline.',
    '- Include a clear defer option when a question can wait, for example `Defer this question`.',
    '- Put the picker before analysis, implementation planning, or Hub data changes. If the request is already specific enough to act on, proceed without inventing questions.',
    '',
    '### Hard limits',
    '',
    '- **Do not** edit application source code, run destructive git operations, open PRs, push branches, or invoke Finalize from this session.',
    '- **Do not** treat this session like a build/ship session: no worktree commit/push lifecycle, no `[Resolve PR #N]` flows.',
    '- Prefer small, reversible Hub changes; confirm before bulk deletes or irreversible config.',
    '',
    '### When code changes are actually needed',
    '',
    workflow
      ? 'Explain the gap and recommend a **dev** project or a workflow run — Consult is Hub-only.'
      : 'Tell the user to switch this session to **Build** (or a higher automation level) before editing code or running Finalize.',
    '',
  ].join('\n');
}
