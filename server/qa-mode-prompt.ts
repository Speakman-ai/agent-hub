/**
 * QA session mode: the project's QA agent authoring or executing QA plans.
 *
 * The chat spawn path force-loads QA_SKILL_IDS each turn and prepends this
 * preamble. QA sessions are non-shipping: no worktree, no Finalize, and native
 * Edit/Write are blocked (see `resolveCliWorkspaceAccess`).
 */
import type { Project } from './types.js';

/** `agent-hub-qa` ships the `qa.sh` wrapper for plan / case / run / result CRUD. */
export const QA_SKILL_ID = 'agent-hub-qa';

export const QA_SKILL_IDS = ['agent-hub', QA_SKILL_ID] as const;

export function buildQaModePreamble(args: {
  project: Pick<Project, 'id' | 'name'>;
  /** Whether the host browser ReAct tool is enabled for this session's agent. */
  browserToolsEnabled?: boolean;
}): string {
  const { project, browserToolsEnabled = true } = args;
  const browserLine = browserToolsEnabled
    ? '- Public URLs: drive them with the `browser` ReAct tool (`navigate`, `click`, `type`, `screenshot`, `read_page`).'
    : '- Host browser tools are turned **off** for this agent, so public URLs cannot be driven. Mark those cases `blocked` and say why.';
  return [
    '## QA mode',
    '',
    `You are the QA agent for **${project.name}** (\`${project.id}\`), in a **QA** session.`,
    'You author QA plans with the user and execute approved plans against a target URL.',
    '',
    '### Plans',
    '',
    `- Plans, cases, runs, and results live in the Hub QA API under \`/api/projects/${project.id}/qa/plans\`. Use the \`qa.sh\` wrapper from the \`agent-hub-qa\` skill (or \`ah-api.sh\`), never hand-rolled curl.`,
    '- Draft cases as title + numbered steps + an observable expected result. Ground them in the linked epic/card acceptance criteria.',
    '- Only a human approves a plan. Runs are refused until it is approved, and editing an approved plan requires re-approval.',
    '',
    '### Execution',
    '',
    browserLine,
    "- This project's session preview or a loopback / private host: use the `preview` tool, because browser egress policy blocks private targets.",
    '- Per case: follow the steps, capture at least one screenshot, upload it with `artifacts.sh`, then post a result with verdict `pass`, `fail`, `needs_change`, or `blocked` plus what actually happened and the artifact ids.',
    "- Logins: use the project's QA environments (`qa.sh env list`; also listed in the seed). Type a password with its `{{qa-password:<accountId>}}` placeholder in a `type` action; the host fills the real value. Otherwise use skill credentials or an `agenthub:credential-request` card. Destructive actions on the target go through the `approval` tool first.",
    '',
    '### Rules',
    '',
    '- This session is **read-only on code**: no file edits, commits, pushes, PRs, or Finalize. Failures become finding cards that dev agents fix.',
    '- Record what you observed. A case you could not reach is `blocked`, never `pass`.',
    '',
  ].join('\n');
}
