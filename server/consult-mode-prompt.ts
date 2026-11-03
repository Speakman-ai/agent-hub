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
  /** The session is a SideBar beside a main session, not a standalone chat. */
  sidebar?: boolean;
  /** This chat's agent. Used when handing a code change to a new session. */
  agentId?: string | null;
}): string {
  const { project, browserToolsEnabled = true, sidebar = false, agentId } = args;
  const workflow = project.mode === 'workflow';
  const shipNote = sidebar
    ? 'No code edits, git ship, or Finalize here.'
    : workflow
      ? 'This is a **workflow** project — there is no Finalize Code Changes flow or session PR automation.'
      : 'This is a **dev** project, but **this chat does not build or finalize**. Answer and check on work here. When a code change is needed, show a Session forward card that starts a new session.';
  const browserLine = browserToolsEnabled
    ? 'The `browser` ReAct tool (host Chromium: `navigate`, `click`, `type`, `extract`, `screenshot`, `read_page`, …) **is available in this session** — use it to open URLs, scrape pages, read live content, or fill forms when a question needs the web. Do not claim you lack web access.'
    : 'Host browser tools are turned **off** for this agent, so omit `tool: browser` from ReAct blocks — `web` search and `wiki` retrieval still work.';
  const sidebarLines = sidebar
    ? [
        '',
        '### SideBar',
        '',
        '- This is a **SideBar**: a side conversation forked from the main session the user is working in. The main session keeps running on its own and never sees this conversation.',
        "- Answer the user's side questions directly and briefly. The main session's working tree is your cwd, so you can read the code it is changing.",
        '- Do not ask the user to switch this SideBar to Build. Code changes belong in the main session; tell the user what to ask for there.',
      ]
    : [];
  return [
    '## Consult mode',
    '',
    `You are in **Consult** mode for project **${project.name}** (\`${project.id}\`).`,
    shipNote,
    ...sidebarLines,
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
    sidebar
      ? 'Explain what the change would be and tell the user to ask for it in the main session.'
      : workflow
        ? 'Explain the gap and recommend a **dev** project or a workflow run — Consult is Hub-only.'
        : [
            'This chat does not build or finalize. If the user asks you to change code, fix something, or start another session, show one Session forward card and stop. Do not run `sessions.sh dispatch`, and do not ask the automation level with `agenthub:ask` — the card has that dropdown.',
            '',
            `The card starts a **new** session on this same agent (\`${agentId || 'this agent'}\`) in project \`${project.id}\`. Do not switch this chat into that mode. Emit exactly one fenced block after a short sentence:`,
            '',
            '```agenthub:forward',
            '{',
            `  "projectId": "${project.id}",`,
            `  "agentId": "${agentId || '<this agent id>'}",`,
            '  "name": "short title",',
            '  "summary": "what the new session will do",',
            '  "prompt": "their request plus any decisions already made in this chat",',
            '  "mode": "manual"',
            '}',
            '```',
            '',
            '`mode` is only your suggestion: Build (`manual`), Build and Review (`review`), Build and Push (`push`), or Auto Merge (`merge`). They can change it, then press Session forward. That button starts the session. Keep talking here. To check on it later, read the session or the board. Still no code edits, git ship, or Finalize from this chat.',
          ].join('\n'),
    '',
  ].join('\n');
}
