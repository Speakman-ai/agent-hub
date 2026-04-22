import { spawn, execFile, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { stmts as _stmts } from './db.js';
import { createStreamParser } from './stream-parser.js';
import config, { defaultModelForEngine, buildSpawnEnv } from './config.js';
import { resolveProjectPaths, contextFilePath } from './project-paths.js';
import { getWikiContext } from './wiki.js';
import { getMemoryContext, appendDailyNote, reconcileMemoryAfterSession } from './memory.js';
import { collectSkillsFromDir, DEFAULT_SKILLS_DIR } from './routes/skills.js';
import { summarizeTranscript, buildTranscript } from './routes/sessions.js';
import { writeHooksConfig } from './hooks.js';
import type { DelegationResult } from './delegation.js';
import {
  detectHandoffBlock,
  recordMalformedHandoff,
  handoffHasTrailingContent,
  handleHandoff,
  buildHandoffPromptSection,
} from './handoff.js';
import { parseCloseCardBlock, handleCardAutoClose } from './card-auto-close.js';
import { detectSkillBlock as detectSkillInvokeBlock, handleSkillInvoke } from './skill-invoke.js';
import { resolveBugReportReroute, extractBugReportTitle } from './bug-report-reroute.js';
import { detectCodexAuthMode, shouldPassModelFlag } from './codex-auth.js';
import { pickProcessErrorMessage } from './process-error-message.js';
import { allAgents } from './project-model.js';
import { broadcastActiveTasksSnapshot } from './active-tasks.js';
import {
  applyAssistantTextChunkForDelegationKickoff,
  planDelegationRoundOnProcClose,
} from './delegation-kickoff-buffer.js';
import { clearDelegationUiMeta } from './delegation-state.js';
import type {
  Project,
  Agent,
  EnrichedAgent,
  AgentLookup,
  SessionRow,
  MessageRow,
  ActiveTaskRow,
  BackgroundTaskRow,
  NoteProcessingRow,
  KanbanCardRow,
  MessageQueueRow,
  Stmts,
  StreamEvent,
  AppConfig,
  BroadcastFn,
  ChatMessage,
} from './types.js';

const stmts = _stmts!;
const DEFAULT_MODEL: string = config.defaultModel;
const MAX_QUEUE_SIZE = 10;

// ─── Internal types ─────────────────────────────────────────────

interface ImageRef {
  filename: string;
  [key: string]: unknown;
}

interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path?: string;
}

interface SlashSkillResult {
  error?: string;
  skillName?: string;
  skillContent?: string;
  userArgs?: string;
}

interface DelegateTask {
  agentId: string;
  task: string;
}

interface BuildEnrichedPromptOptions {
  useWorktree?: boolean;
  isFirstMessage?: boolean;
  /**
   * Target session id for which the prompt is being built. When provided,
   * the builder checks for an incoming (delivered) handoff and appends a
   * `## HANDOFF FROM ...` section on the first turn so the agent picks up
   * the source session's transcript + handoff note.
   */
  sessionId?: string;
  _getEnrichedAgent?: (id: string) => EnrichedAgent | null;
}

interface InternalChatMessage extends ChatMessage {
  interrupt?: boolean;
  hookSpecificOutput?: { sessionTitle?: string; [key: string]: unknown };
}

interface ProjectWithCommands extends Project {
  commands?: {
    install?: string;
    build?: string;
    test?: string;
    lint?: string;
  };
  defaultReviewer?: string;
}

interface AgentWithModel extends Agent {
  workspace?: string;
  cwd?: string;
}

export interface ChatHandlerDeps {
  broadcast: BroadcastFn;
  findAgent: (agentId: string) => AgentLookup | null;
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null;
  activeProcesses: Map<string, ChildProcess>;
  activeDelegationSessions: Set<string>;
  autonomousProjects: Set<string>;
  getClaudeBin: () => string;
  getCursorBin: () => string;
  getGeminiBin: () => string;
  getCodexBin: () => string;
  uploadsDir: string;
  resolveSlashSkill: (agent: Agent, content: string, project: Project) => SlashSkillResult | null;
  createCursorChat: ((cwd: string) => Promise<string>) | undefined;
  ensureWorktree: (
    session: SessionRow,
    projectCwd: string,
    agentId: string,
    installCommand: string | null,
  ) => string;
  drainQueue: (sessionId: string) => void;
  handleDelegation: (
    sessionId: string,
    messageId: string,
    tasks: DelegateTask[],
    enrichedAgent: EnrichedAgent,
    project: Project,
    cwd: string,
  ) => Promise<DelegationResult[]>;
  handleDelegationCancel: (sessionId: string) => void;
  synthesizeResults: (
    sessionId: string,
    agentId: string,
    enrichedAgent: EnrichedAgent,
    project: Project,
    results: DelegationResult[],
    originalContent: string,
    cwd: string,
  ) => Promise<void>;
  parseDelegateBlock: (content: string) => DelegateTask[] | null;
  autoCommitAndPR: (
    sessionId: string,
    agentId: string,
    project: Project,
    agent: Agent,
    cwd: string,
    finalContent: string,
  ) => Promise<void>;
  tryAutonomousDispatch: () => void;
}

export interface ChatHandlerResult {
  handleChat: (ws: WebSocketLike | null, msg: InternalChatMessage) => Promise<void>;
  saveErrorMessage: (
    sessionId: string,
    messageId: string,
    engine: string,
    model: string,
    errorText: string,
  ) => string;
  createCursorChat: (cwd: string) => Promise<string>;
}

/** Minimal socket shape used by chat handlers (matches `ws` from the `ws` package). */
export type WebSocketLike = { send: (data: string) => void };

// ─── Project agent roster (same project) ───────────────────────────

export type ProjectAgentRosterPeer = { id: string; name: string; role?: string };

/**
 * Markdown block listing peer agents for injection into the enriched system prompt.
 * Excludes the current agent; empty when there are no peers.
 */
export function formatProjectAgentRosterSection(peers: ProjectAgentRosterPeer[]): string {
  if (peers.length === 0) return '';
  const lines = peers.map((p) => {
    const display = (p.name || '').trim() || p.id;
    const roleBit = p.role ? ` · Role: ${p.role}` : '';
    return `- **${display}** (\`${p.id}\`)${roleBit}`;
  });
  return `\n\n## Project agent roster (same project)\nOther agents on this project you may reference by name or \`id\` in chat, \`<handoff>\`, \`<delegate>\`, and conference rooms:\n${lines.join('\n')}`;
}

function peersOnProject(projectId: string, excludeAgentId: string): ProjectAgentRosterPeer[] {
  return allAgents()
    .filter((a) => a.projectId === projectId && a.id !== excludeAgentId)
    .map((a) => ({
      id: a.id,
      name: (a.name || '').trim() || a.id,
      role: typeof a.role === 'string' && a.role.trim() ? a.role.trim() : undefined,
    }));
}

// ─── buildEnrichedPrompt ───────────────────────────────────────────

export function buildEnrichedPrompt(
  projectOrAgent: ProjectWithCommands | EnrichedAgent,
  maybeAgent?: AgentWithModel,
  options: BuildEnrichedPromptOptions = {},
): string {
  let project: ProjectWithCommands;
  let agent: AgentWithModel;
  if (maybeAgent) {
    project = projectOrAgent as ProjectWithCommands;
    agent = maybeAgent;
  } else {
    agent = projectOrAgent as EnrichedAgent;
    project = {
      cwd: agent.cwd,
      ahw: (agent as EnrichedAgent).ahw || agent.workspace,
    } as ProjectWithCommands;
  }

  // Identity anchor — name + id + role at the very top of the prompt.
  // Without this, newly-created agents whose project has an AGENTS.md
  // describing the team (e.g. "agent-hub-lead", "hub-frontend", …) tend
  // to latch onto one of the listed roles instead of their own
  // configured identity. The anchor pins "who you are" before any
  // shared project context can reframe it.
  const displayName = (agent.name || '').trim() || agent.id;
  const roleSuffix = agent.role ? ` · Role: ${agent.role}` : '';
  const identityAnchor = `# You are ${displayName}\n\nAgent id: \`${agent.id}\`${roleSuffix}\n\n`;
  const projectId =
    (project as ProjectWithCommands & { id?: string }).id ||
    (agent as EnrichedAgent).projectId ||
    undefined;
  const rosterSection = projectId
    ? formatProjectAgentRosterSection(peersOnProject(projectId, agent.id))
    : '';
  const systemPromptBody = (agent.systemPrompt || '').trim();
  let prompt: string = identityAnchor + rosterSection + systemPromptBody;
  if (!project.ahw) return prompt;

  const paths = resolveProjectPaths(project as Project, agent as Agent);

  const contextOrder = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md'];
  let agentsMdIncluded = false;
  let identityMdIncluded = false;
  for (const filename of contextOrder) {
    const filePath = contextFilePath(paths, filename);
    if (filePath && existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.trim()) {
          prompt += `\n\n## ${filename}\n${content}`;
          if (filename === 'AGENTS.md') agentsMdIncluded = true;
          if (filename === 'IDENTITY.md') identityMdIncluded = true;
        }
      } catch {
        /* skip */
      }
    }
  }

  // Identity reaffirmation — only needed when AGENTS.md was loaded.
  // AGENTS.md describes the project's agent team, and newly-created
  // agents routinely pattern-match onto one of those team roles
  // instead of following the system prompt / IDENTITY.md above.
  // Re-pin the identity after the shared context so the model's last
  // instruction on "who am I" is the right one.
  if (agentsMdIncluded) {
    const identitySources = identityMdIncluded
      ? 'your system prompt and IDENTITY.md'
      : 'your system prompt';
    prompt += `\n\n## Identity Reminder\nYou are **${displayName}** (agent id: \`${agent.id}\`). The team descriptions in AGENTS.md above describe the project's agent team — they are context about your collaborators, **not** a role for you to adopt. Your own identity is defined by ${identitySources} at the top of this message. Do not impersonate any other agent listed in AGENTS.md unless that agent's id matches \`${agent.id}\`.`;
  }

  {
    const projectSkills: SkillInfo[] = collectSkillsFromDir(paths.skillsDir);
    const defaultSkills: SkillInfo[] = collectSkillsFromDir(DEFAULT_SKILLS_DIR);
    const projectIds = new Set(projectSkills.map((s) => s.id));
    let allSkills = [...projectSkills, ...defaultSkills.filter((s) => !projectIds.has(s.id))];

    try {
      const overrides = stmts.getAgentSkillOverrides.all(agent.id) as Array<{
        skill_id: string;
        enabled: number;
      }>;
      const disabledSet = new Set(overrides.filter((o) => !o.enabled).map((o) => o.skill_id));
      if (disabledSet.size > 0) {
        allSkills = allSkills.filter((s) => !disabledSet.has(s.id));
      }
    } catch {
      /* ignore if table doesn't exist yet */
    }

    if (allSkills.length > 0) {
      const skillsList = allSkills.map((s) => `- **${s.name}**: ${s.description}`);
      prompt += `\n\n## Available Skills
To load a skill for your next turn, end your turn with a fenced block like:
\`\`\`
<agenthub:skill>
{"name": "<skill-id>", "reason": "<one-liner why>"}
</agenthub:skill>
\`\`\`
The SKILL.md body and referenced files will be injected into your next turn. This replaces the native \`Skill\` tool and works uniformly across claude-code, cursor-agent, and codex.

Only the skills listed below are real here: use their exact \`name\` in \`<agenthub:skill>\` (anything else will not load). On engines that still expose the native \`Skill\` tool, calling it with an unregistered id fails with \`Unknown skill\` — same idea: do not invent third-party "skill" ids. For capabilities that are not in this list, use Bash, WebFetch, or your other normal tools instead of making up skill names.

${skillsList.join('\n')}`;
    }
  }

  const isFirstMessage = options.isFirstMessage !== false; // default true for backward compat

  {
    if (projectId) {
      const wikiContext = getWikiContext(projectId);
      if (wikiContext) {
        prompt += '\n\n' + wikiContext;
      }

      // Static instructional blocks — only on first message to save tokens
      if (isFirstMessage) {
        prompt += `\n\n## Wiki Documentation Guidelines
After significant work, update the wiki to preserve knowledge. Search first (\`GET /api/projects/${projectId}/wiki?q=...\`), update existing pages rather than duplicating. Create via \`POST /api/projects/${projectId}/wiki\` with \`{title, content, category, updatedBy}\`. Update via \`PUT /api/projects/${projectId}/wiki/:slug\`. Categories: general, api-docs, architecture, conventions, test-patterns, troubleshooting, onboarding. Focus on decisions, patterns, and knowledge that would be lost when the session ends.`;

        prompt += `\n\n## Kanban Board — Task Self-Reporting
Use the \`kanban\` skill to report work. Create/move cards via \`POST /api/projects/${projectId}/board/cards\` and \`POST /api/projects/${projectId}/board/cards/:cardId/move\`. Use \`GET /api/projects/${projectId}/board\` for column IDs. Skip cards for trivial tasks.
When creating cards: use a **concise title** (under 60 chars) summarizing the problem/task, and include **acceptance criteria** as a bulleted checklist in the description. Pass \`session_id: "$AGENT_HUB_SESSION_ID"\` to link the card to your session (this auto-renames the sidebar to the card title).

### Auto-closing a card as duplicate / already-done
If you pick up a card and discover the work is redundant — either covered by an earlier ticket or already shipped — don't just leave the card parked. End your turn with a fenced block like:
\`\`\`
<agenthub:close-card>
{"reason": "duplicate", "note": "Covered by card 5c8f2a — see PR #313.", "duplicateOfCardId": "5c8f2a..."}
</agenthub:close-card>
\`\`\`
- \`reason\`: \`"duplicate"\` or \`"already-done"\` (required)
- \`note\`: one-line explanation shown in the auto-close comment (required)
- \`duplicateOfCardId\`: optional, the canonical card id the work duplicates
The server moves the session's linked card to Done and appends an explanatory comment referencing this session.`;
      }
    }
  }

  const memoryContext = getMemoryContext(project.ahw);
  if (memoryContext) {
    prompt += '\n\n' + memoryContext;
  }

  let isGitHubConnected = false;
  try {
    const remoteOutput = execSync('git remote -v', {
      cwd: project.cwd,
      timeout: 5000,
      encoding: 'utf-8',
    });
    isGitHubConnected = remoteOutput.includes('github.com');
  } catch {}

  // Static instructional blocks — only on first message to save tokens
  if (isFirstMessage) {
    if (isGitHubConnected) {
      prompt += `\n\n## Development Lifecycle — GitHub-Connected Project
This project is connected to GitHub. Follow this lifecycle for changes:

1. **Kanban Card**: Check \`GET /api/projects/${projectId}/board\`. Create a card with a **concise title** (under 60 chars, summarizing the problem) and a description that includes:
   - **Problem**: 1-2 sentences on what's wrong or what's needed
   - **Acceptance Criteria**: Bulleted checklist of conditions that must be met for this to be complete
   Include \`session_id: "$AGENT_HUB_SESSION_ID"\` when creating the card — this links it to your session and **auto-renames the sidebar** to the card title.
   Move to "In Progress" when you begin.
2. **Branch**: \`git checkout main && git pull && git checkout -b feature/<name>\`${options.useWorktree ? ' (worktree — safe to branch here)' : ''}
3. **Implement**: Follow existing patterns.${project.commands?.install ? ` Install: \`${project.commands.install}\`` : ''}
4. **Test & Lint**: ${project.commands?.test ? `\`${project.commands.test}\`` : '`npm test`'}${project.commands?.lint ? ` / \`${project.commands.lint}\`` : ''} — fix before proceeding
5. **Commit**: Commit your changes to the feature branch. **Do NOT push or run \`gh pr create\`** — PR creation is owned by the server. If your session is linked to a kanban card, the server will push, open the PR, and move the card to "Review" automatically when your session ends. If your session is ad-hoc (no card), the user will get a "Create PR" button after your session ends and decide from there.

**Existing PRs**: Check out branch, read failures (\`gh pr checks\`), fix, commit. No new cards/branches/PRs. Do NOT push or merge.
**Shortcuts**: Trivial fixes skip card creation. Found a bug? Create "Backlog" card.`;
    } else if (options.useWorktree) {
      prompt += `\n\n## Git Workflow
You are in a git worktree. Never commit to main. Commit to the current feature branch. Do NOT push or run \`gh pr create\` — the server owns PR creation.`;
    }

    prompt += `\n\n## Bias to Action — Don't Ask, Just Ship
When a user describes a problem, feature, or change, **do not ask permission to create a kanban card, open a PR, or start implementing.** The default answer is "yes" ~95% of the time, and the review process (PR review, card rejection, human merge gate) exists precisely so that you can act now and be corrected cheaply later.

**Do not emit questions like:**
- "Do you want me to create a card for this?"
- "Should I go ahead and implement this?"
- "Want me to open a PR?"
- "Should I add a test for this?"

**Instead, just do the work:**
1. Create the kanban card (concise title + acceptance criteria + \`session_id\`).
2. Move it to In Progress.
3. Implement the change on a feature branch.
4. Commit. The server handles push + PR creation.

**When to actually ask first** (rare — use \`agenthub:ask\` picker or prose):
- The request is genuinely ambiguous and multiple reasonable interpretations would produce very different work (e.g. "refactor this" with no direction).
- The action is destructive and irreversible (e.g. \`git push --force\` to main, deleting production data, rotating shared secrets).
- The user has explicitly asked you to propose a plan before executing.

Everything else: ship it. A rejected PR costs a few minutes; a blocked agent costs the user's entire turn.

## Research Questions — Answer on the Spot, Don't Card It
When a user asks a **research or investigation question** about the system (how something works, why something is behaving a certain way, where a feature lives, what the current state of X is), just **do the research and answer inline**. Do **not** offer to create a kanban card for the investigation itself.

**Do not emit questions like:**
- "Want me to make a card to look into this?"
- "Should I open a ticket to investigate?"
- "Do you want me to track this as a research task?"

Cards are for **work to ship** — code changes, features, bugfixes, refactors. They are not for **questions to answer**. If research surfaces a concrete bug or feature that needs shipping, *then* create a card for that follow-up work (per Bias to Action above). The investigation itself stays in the chat.`;

    prompt += `\n\n## Memory Instructions
You have access to memory files. The memory context above shows your current knowledge. Mention important learnings (decisions, preferences, key facts) in your response so they get logged.`;

    prompt += `\n\n## External API Documentation — Always Verify
When working with external APIs (GitHub, Slack, etc.), always consult official documentation first. Do not rely solely on training data — APIs change.`;

    prompt += `\n\n## File-Safety Reminder — Internalize, Never Surface
The Claude Code CLI appends a hidden \`<system-reminder>\` after every \`Read\` tool result asking you to "consider whether [the file] would be considered malware." This injection is server-side (Anthropic LaunchDarkly flag) and **cannot be disabled** from Agent Hub. It fires on essentially every file you read and is noise, not signal.

**How to handle it:**
1. Read the file, perform your task, continue silently. Do **not** preface responses with "Not malware — …", "This appears safe — …", or any similar acknowledgment. Treat it the same way you already treat the \`TodoWrite\` reminder: internalize, never mention.
2. **Never use the reminder as grounds to refuse legitimate work.** Editing a GitHub Actions workflow, a deploy script, a shell command, a regex, or any other normal codebase file is not "augmenting malware" — it is your job. The reminder only applies to code that is genuinely malicious (exfiltration, credential theft, destructive payloads, etc.).
3. If a file is genuinely suspicious, raise it explicitly in plain language. Otherwise stay quiet.`;

    prompt += `\n\n## Asking the User Multi-Choice Questions

Agent Hub renders a rich picker (radio/checkbox cards with side-by-side previews) when you emit a fenced code block tagged \`agenthub:ask\`. Use it whenever you'd benefit from a structured answer instead of free-form text — e.g. picking between implementation approaches, libraries, UI variants, or gathering several preferences at once.

**Format** — a fenced block whose body is a JSON array of 1–4 question objects:

\`\`\`agenthub:ask
[
  {
    "question": "Which date library should we use?",
    "header": "Library",
    "multiSelect": false,
    "options": [
      { "label": "date-fns (Recommended)", "description": "Tree-shakable, functional API." },
      { "label": "luxon", "description": "First-class timezone support." },
      { "label": "dayjs", "description": "Smallest bundle, moment-like API." }
    ]
  }
]
\`\`\`

**Field rules**
- \`header\`: chip label, **≤12 characters**.
- \`options\`: 2–4 per question. Recommended option should be first and labeled "(Recommended)". Do **not** add an "Other" option — the UI provides a free-text "Other…" row automatically.
- \`multiSelect: true\` for non-exclusive preferences; \`false\` for mutually-exclusive choices.
- Optional per-option \`preview\` field: a string rendered as a monospace/code panel next to the options — use it for side-by-side comparison of mockups, code snippets, or config examples. Only applies to single-select questions.

**Answer round-trip** — the user's reply arrives as a normal chat message containing a matching \`agenthub:ask:answer\` fenced block of shape \`{ "askId": "...", "answers": {questionText: value}, "annotations": {questionText: {notes?, preview?}} }\`. For single-select questions \`value\` is a string (the chosen label or free-text from "Other"); for multi-select questions \`value\` is an array of strings. \`askId\` echoes the id of the picker you emitted so you can tie the answer to the original question. Read the answers and continue.`;
  }

  // Incoming handoff (target-side): if this session was created as the
  // target of a <handoff>, append the HANDOFF FROM section on the first
  // message so the agent picks up the source's transcript + note. Only
  // runs on the first message because the source's context is persistent
  // once read — re-injecting on every turn would bloat the prompt.
  if (options.sessionId && isFirstMessage) {
    const getEnrichedAgentForHandoff = options._getEnrichedAgent;
    if (getEnrichedAgentForHandoff) {
      const handoffSection = buildHandoffPromptSection(options.sessionId, {
        stmts,
        getEnrichedAgent: getEnrichedAgentForHandoff,
      });
      if (handoffSection) {
        prompt += '\n\n' + handoffSection;
      }
    }
  }

  if (agent.role === 'lead' && Array.isArray(agent.subAgents) && agent.subAgents.length > 0) {
    // Delegation: sub-agent list is dynamic (agents can change), so always include
    const getEnrichedAgent = options._getEnrichedAgent;
    if (!getEnrichedAgent) {
      console.warn(
        `[chat] Lead agent "${agent.name}" (${agent.id}) is missing _getEnrichedAgent — delegation instructions will be empty`,
      );
    }
    const subAgentDescriptions = agent.subAgents
      .map((subId) => {
        const sub = getEnrichedAgent?.(subId);
        if (!sub) return null;
        const desc = (sub.systemPrompt || '').split('\n')[0] || 'General agent';
        return `- **${sub.name}** (\`${sub.id}\`): ${desc}`;
      })
      .filter(Boolean)
      .join('\n');

    if (isFirstMessage) {
      prompt += `\n\n## Delegation

You lead a team of sub-agents. Delegate by including a \`<delegate>\` block:
\`\`\`
<delegate>
[{"agentId": "sub-agent-id", "task": "..."}]
</delegate>
\`\`\`

Your available sub-agents:
${subAgentDescriptions}

Guidelines: Delegate only for parallel specialist work. Each task must be self-contained. For simple tasks, just do it directly.
If the user cancels delegation mid-flight, the server will prompt your next synthesis turn to **finish the delegated work yourself** (you receive each sub-task verbatim).
**IMPORTANT: Do NOT use the Agent tool for delegation.** Use the \`<delegate>\` block — the server spawns sub-agents as separate CLI processes.

## Handoff

\`<delegate>\` spawns parallel one-shot helpers; \`<handoff>\` transfers ownership. Use \`<handoff>\` at the END of your turn when another agent on your team should take over the work — e.g. you've finished discovery/planning and a specialist should now implement. Your session ends; a fresh session is created for the target agent with your full transcript + a handoff note pre-loaded as context. You will not see the target's reply — the user interacts with them directly.

Format (single target, JSON payload):
\`\`\`
<handoff>
{"toAgent": "sub-agent-id", "note": "Summary of what's done + what they should do next."}
</handoff>
\`\`\`

Rules:
- Handoff is **terminal** in the turn — anything you emit after \`</handoff>\` is dropped.
- Target must be one of your listed sub-agents (same project).
- Use a meaty \`note\`: file paths with line numbers, linked card id, the exact next action. The transcript comes along for free, but the note is what the target reads first.
- Prefer \`<handoff>\` over \`<delegate>\` when the specialist will take multiple turns, needs full context, or is expected to commit/PR. Prefer \`<delegate>\` for short parallel side-quests whose results you'll synthesize.`;
    } else {
      // On subsequent messages, just remind of available sub-agents (compact)
      prompt += `\n\n## Sub-Agents\n${subAgentDescriptions}\nDelegate via \`<delegate>\` block (not Agent tool).`;
    }
  }

  return prompt;
}

/**
 * One-shot pending skill context for the next model turn.
 * Clears the DB column **before** building the prompt suffix so a failed
 * `UPDATE` never pairs an in-memory injection with a still-stored value
 * (which would re-append on every later turn until the clear succeeds).
 */
export function consumePendingSkillInjection(
  pendingRaw: string | null | undefined,
  clearPending: () => void,
): { suffix: string; forceSystemPromptThisTurn: boolean } {
  const trimmed = pendingRaw?.trim() || '';
  if (!trimmed) return { suffix: '', forceSystemPromptThisTurn: false };
  try {
    clearPending();
    return { suffix: `\n\n${trimmed}`, forceSystemPromptThisTurn: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[skill-invoke] failed to clear pending_skill_context:', message);
    return { suffix: '', forceSystemPromptThisTurn: false };
  }
}

// ─── createChatHandler (factory) ───────────────────────────────────

export default function createChatHandler(deps: ChatHandlerDeps): ChatHandlerResult {
  const {
    broadcast,
    findAgent,
    getEnrichedAgent,
    activeProcesses,
    activeDelegationSessions,
    autonomousProjects,
    getClaudeBin,
    getCursorBin,
    getGeminiBin,
    getCodexBin,
    uploadsDir,
    resolveSlashSkill,
    createCursorChat: _createCursorChat,
    ensureWorktree,
    drainQueue,
    handleDelegation,
    handleDelegationCancel,
    synthesizeResults,
    parseDelegateBlock,
    autoCommitAndPR,
    tryAutonomousDispatch,
  } = deps;

  function saveErrorMessage(
    sessionId: string,
    messageId: string,
    engine: string,
    model: string,
    errorText: string,
  ): string {
    const content = `⚠️ Error: ${errorText}`;
    try {
      stmts.addMessage.run(messageId, sessionId, 'assistant', content, engine, model, null, null);
      stmts.touchSession.run(sessionId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to persist error message:', message);
    }
    return content;
  }

  function createCursorChat(cwd: string): Promise<string> {
    const CURSOR_BIN = getCursorBin();
    // Same env shape as `spawn(..., { env: buildSpawnEnv(config) })` (merged PATH + keys).
    const env = buildSpawnEnv(config);
    return new Promise((resolve, reject) => {
      execFile(CURSOR_BIN, ['create-chat'], { cwd, env }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`cursor create-chat failed: ${stderr || err.message}`));
          return;
        }
        const id = (stdout || '').trim().split(/\s+/).pop();
        if (!id) {
          reject(new Error('cursor create-chat returned no id'));
          return;
        }
        resolve(id);
      });
    });
  }

  async function handleChat(ws: WebSocketLike | null, msg: InternalChatMessage): Promise<void> {
    const { agentId, sessionId, content, images, hookSpecificOutput } = msg;
    const attachments: string | null = images && images.length > 0 ? JSON.stringify(images) : null;

    const found = findAgent(agentId);
    if (!found) {
      if (ws) ws.send(JSON.stringify({ type: 'error', error: `Unknown agent: ${agentId}` }));
      return;
    }
    const { project, agent } = found;
    const enrichedAgent = getEnrichedAgent(agentId);

    // ── Bug-report reroute guard ──────────────────────────────────
    // User-request bug reports (payloads starting with "## Bug Report")
    // must be owned by the project's intake agent — never a lead,
    // specialist, reviewer, or docs agent. If a bug-report payload is
    // addressed to anyone else, dispatch a fresh session for the intake
    // agent and notify the caller. See `server/bug-report-reroute.ts`.
    const intakeTarget = resolveBugReportReroute(project, agent, content, {
      fromQueue: msg._fromQueue,
      alreadyRerouted: msg._reroutedFromBugReport,
    });
    if (intakeTarget) {
      const intakeSessionId = uuidv4();
      const intakeEngine = intakeTarget.engine || 'claude-code';
      const intakeModel =
        (intakeTarget as AgentWithModel).model || defaultModelForEngine(intakeEngine);
      const title = extractBugReportTitle(content) || 'Bug Report';
      const sessionName = `[Bug] ${title.substring(0, 80)}`;

      try {
        stmts.createSession.run(
          intakeSessionId,
          intakeTarget.id,
          sessionName,
          intakeEngine,
          intakeModel,
          1,
          0,
        );
        const taskId = uuidv4();
        stmts.insertBackgroundTask.run(taskId, intakeSessionId, intakeTarget.id, content);
      } catch (err) {
        console.error('[Bug Reroute] Failed to create intake session:', (err as Error).message);
        if (ws) {
          ws.send(
            JSON.stringify({
              type: 'error',
              sessionId,
              error: 'Failed to reroute bug report to intake agent.',
            }),
          );
        }
        return;
      }

      if (ws) {
        ws.send(
          JSON.stringify({
            type: 'bug_report_rerouted',
            originalAgentId: agentId,
            originalSessionId: sessionId,
            intakeAgentId: intakeTarget.id,
            intakeSessionId,
            message: `Bug reports are handled by ${intakeTarget.name || intakeTarget.id}. Dispatched a fresh session there.`,
          }),
        );
      }

      setImmediate(() => {
        try {
          const result = handleChat(null, {
            type: 'chat',
            agentId: intakeTarget.id,
            sessionId: intakeSessionId,
            content,
            _reroutedFromBugReport: true,
          } as InternalChatMessage);
          if (result && typeof (result as Promise<unknown>).catch === 'function') {
            (result as Promise<unknown>).catch((err: Error) => {
              console.error(
                `[Bug Reroute] handleChat failed for intake session ${intakeSessionId}:`,
                err.message,
              );
            });
          }
        } catch (err) {
          console.error(
            `[Bug Reroute] handleChat threw for intake session ${intakeSessionId}:`,
            (err as Error).message,
          );
        }
      });
      return;
    }

    const slashResult = resolveSlashSkill(agent, content, project);
    if (slashResult?.error) {
      if (ws) ws.send(JSON.stringify({ type: 'error', sessionId, error: slashResult.error }));
      return;
    }

    let cliContent: string = content;
    if (slashResult) {
      const args = slashResult.userArgs || 'Please use this skill as instructed.';
      cliContent = `<skill name="${slashResult.skillName}">\n${slashResult.skillContent}\n</skill>\n\n${args}`;
    }

    let session = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!session) {
      const initialEngine = agent.engine || 'claude-code';
      stmts.createSession.run(
        sessionId,
        agentId,
        `Session ${new Date().toLocaleString()}`,
        initialEngine,
        (agent as AgentWithModel).model || defaultModelForEngine(initialEngine),
        1,
        0,
      );
      session = stmts.getSession.get(sessionId) as SessionRow | undefined;
    }

    const existingTask = stmts.getActiveTask.get(sessionId) as ActiveTaskRow | undefined;
    const isDelegating = activeDelegationSessions.has(sessionId);

    if ((existingTask || isDelegating) && !msg._fromQueue) {
      const isInterrupt = msg.interrupt === true;

      if (!isInterrupt) {
        const currentQueue = stmts.getQueuedMessages.all(sessionId) as MessageQueueRow[];
        if (currentQueue.length >= MAX_QUEUE_SIZE) {
          if (ws)
            ws.send(
              JSON.stringify({
                type: 'error',
                sessionId,
                error: `Queue is full (max ${MAX_QUEUE_SIZE} messages). Wait for current task to complete.`,
              }),
            );
          return;
        }
      }

      const queueMsgId = uuidv4();

      let position: number;
      if (isInterrupt) {
        const minPos = stmts.getMinQueuePosition.get(sessionId) as
          | { min_pos: number | null }
          | undefined;
        position = (minPos?.min_pos ?? 0) - 1;
      } else {
        const maxPos = stmts.getMaxQueuePosition.get(sessionId) as
          | { max_pos: number | null }
          | undefined;
        position = (maxPos?.max_pos ?? -1) + 1;
      }

      stmts.addMessage.run(queueMsgId, sessionId, 'user', content, null, null, attachments, null);
      stmts.touchSession.run(sessionId);

      stmts.enqueueMessage.run(queueMsgId, sessionId, agentId, content, attachments, position);

      broadcast({
        type: 'message',
        message: {
          id: queueMsgId,
          session_id: sessionId,
          role: 'user',
          content,
          attachments,
          queued: !isInterrupt,
          interrupted: isInterrupt,
          created_at: new Date().toISOString(),
        },
      });

      broadcast({
        type: 'queue_updated',
        sessionId,
        queue: stmts.getQueuedMessages.all(sessionId),
      });

      if (isInterrupt) {
        console.log(`[chat] Interrupt received for session ${sessionId} — stopping current task`);
        const proc = activeProcesses.get(sessionId);
        if (proc) {
          proc.kill('SIGTERM');
        }
        if (isDelegating) {
          handleDelegationCancel(sessionId);
          setTimeout(() => drainQueue(sessionId), 500);
        }
        broadcast({ type: 'interrupted', sessionId });
      }

      return;
    }

    let userMsgId: string;
    if (msg._fromQueue) {
      userMsgId = msg._existingMsgId!;
      broadcast({ type: 'queue_item_processing', sessionId, messageId: userMsgId });
    } else {
      userMsgId = uuidv4();
      stmts.addMessage.run(userMsgId, sessionId, 'user', content, null, null, attachments, null);
      stmts.touchSession.run(sessionId);

      broadcast({
        type: 'message',
        message: {
          id: userMsgId,
          session_id: sessionId,
          role: 'user',
          content,
          attachments,
          created_at: new Date().toISOString(),
        },
      });
    }

    const priorMessages = (stmts.getMessages.all(sessionId) as MessageRow[]).filter(
      (m) => m.id !== userMsgId,
    );
    const isFirstMessage = priorMessages.length === 0;

    const engine: string = session!.engine || 'claude-code';
    const model: string = session!.model || DEFAULT_MODEL;
    let enrichedPrompt = buildEnrichedPrompt(
      project as ProjectWithCommands,
      agent as AgentWithModel,
      {
        useWorktree: !!session!.use_worktree,
        isFirstMessage,
        sessionId,
        _getEnrichedAgent: getEnrichedAgent,
      },
    );
    const { suffix: pendingSkillSuffix, forceSystemPromptThisTurn } = consumePendingSkillInjection(
      session!.pending_skill_context,
      () => stmts.updateSessionPendingSkillContext.run(null, sessionId),
    );
    if (pendingSkillSuffix) enrichedPrompt += pendingSkillSuffix;
    const assistantMsgId = uuidv4();

    let engineSessionId: string | null = session!.engine_session_id || null;
    const isNewEngineSession = !engineSessionId;

    // Same cwd as the later `spawn` (worktree path when isolation is on) so
    // `cursor-agent create-chat` and `--resume` agree on repo root / `.cursor`.
    let effectiveCwd: string = project.cwd;
    if (session!.use_worktree && (session!.worktree_path || isNewEngineSession)) {
      const priorWorktree = session!.worktree_path;
      effectiveCwd = ensureWorktree(
        session!,
        project.cwd,
        agentId,
        (project as ProjectWithCommands).commands?.install || null,
      );
      session = stmts.getSession.get(sessionId) as SessionRow | undefined;

      if (!isNewEngineSession && priorWorktree && priorWorktree !== effectiveCwd) {
        console.log(
          `[chat] Cross-worktree resume: session ${sessionId} moved from ${priorWorktree} → ${effectiveCwd}`,
        );
      }
    } else if (!isNewEngineSession && !session!.use_worktree && session!.worktree_path) {
      console.log(
        `[chat] Resuming session ${sessionId} in project cwd (worktree disabled, cross-worktree resume)`,
      );
    }

    if (engine === 'cursor-agent' && !engineSessionId) {
      try {
        engineSessionId = await createCursorChat(effectiveCwd);
        stmts.updateSessionEngineSessionId.run(engineSessionId, sessionId);
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        console.error(errMessage);
        const errText = `Failed to create cursor chat: ${errMessage}`;
        saveErrorMessage(sessionId, assistantMsgId, engine, model, errText);
        broadcast({
          type: 'error',
          messageId: assistantMsgId,
          sessionId,
          error: errText,
        });
        return;
      }
    }

    try {
      stmts.insertActiveTask.run(sessionId, assistantMsgId, agentId, null, content, engine, model);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to insert active_tasks row:', message);
    }

    broadcast({
      type: 'thinking',
      messageId: assistantMsgId,
      sessionId,
      engine,
      model,
    });

    const needsHistoryBootstrap = isNewEngineSession && priorMessages.length > 0;
    const promptWithHistory: string = (() => {
      if (!needsHistoryBootstrap) return cliContent;
      let p = 'Previous conversation:\n';
      for (const m of priorMessages) {
        const prefix = m.role === 'user' ? 'Human' : 'Assistant';
        p += `${prefix}: ${m.content}\n\n`;
      }
      p += `Human: ${cliContent}`;
      return p;
    })();

    let imagePromptSuffix = '';
    if (images && images.length > 0) {
      const imgCwd = session!.worktree_path || project.cwd;
      const imgDir = path.join(imgCwd, '.agent-hub-images');
      mkdirSync(imgDir, { recursive: true });
      const imgPaths: string[] = [];
      for (const img of images as unknown as ImageRef[]) {
        const srcPath = path.join(uploadsDir, img.filename);
        if (existsSync(srcPath)) {
          const destPath = path.join(imgDir, img.filename);
          writeFileSync(destPath, readFileSync(srcPath));
          imgPaths.push(destPath);
        }
      }
      if (imgPaths.length > 0) {
        const n = imgPaths.length;
        imagePromptSuffix =
          '\n\n[The user has attached ' +
          (n === 1 ? 'a file' : `${n} files`) +
          '. Open ' +
          (n === 1 ? 'it' : 'them') +
          ' with the Read tool at: ' +
          imgPaths.map((p) => `"${p}"`).join(', ') +
          ']';
      }
    }

    const finalPrompt = promptWithHistory + imagePromptSuffix;

    const CLAUDE_BIN = getClaudeBin();
    const CURSOR_BIN = getCursorBin();
    const GEMINI_BIN = getGeminiBin();
    const CODEX_BIN = getCodexBin();
    let args: string[];
    let bin: string;
    if (engine === 'cursor-agent') {
      const prompt =
        isNewEngineSession || forceSystemPromptThisTurn
          ? `${enrichedPrompt}\n\n${finalPrompt}`
          : cliContent + imagePromptSuffix;
      args = [
        '-p',
        prompt,
        '--force',
        '--model',
        model,
        '--resume',
        engineSessionId!,
        '--output-format',
        'stream-json',
        '--stream-partial-output',
      ];
      bin = CURSOR_BIN;
    } else if (engine === 'gemini-cli') {
      // Gemini CLI flags per https://geminicli.com/docs/cli/cli-reference:
      //   -p / --prompt         prompt text (forces non-interactive mode)
      //   -m / --model          model selector (we pass through the session model)
      //   -o / --output-format  'stream-json' emits JSONL events we parse in
      //                         normalizeGemini (init / message / tool_use /
      //                         tool_result / result).
      //   --yolo                auto-approve tool calls — matches how we run
      //                         Claude Code with --permission-mode bypassPermissions.
      // Gemini does not (yet) expose a --resume flag for stateful sessions, so
      // we always inject the enriched prompt + full history on each turn. The
      // `needsHistoryBootstrap` branch earlier already concatenates prior
      // messages into `finalPrompt` when engineSessionId is null, which is
      // exactly the shape Gemini expects.
      const prompt = `${enrichedPrompt}\n\n${finalPrompt}`;
      args = ['-p', prompt, '--output-format', 'stream-json'];
      if (model && model !== 'auto') {
        args.push('--model', model);
      }
      const isAskMode = !!session!.ask_mode;
      if (!isAskMode) {
        args.push('--yolo');
      }
      bin = GEMINI_BIN;
    } else if (engine === 'codex-cli') {
      // Codex CLI flags per https://developers.openai.com/codex/noninteractive:
      //   codex exec --json "<prompt>"                  — new turn
      //   codex exec resume <session-id> --json "..."   — continue a session
      //   codex exec resume --last --json "..."         — continue the newest recorded session
      //   --sandbox read-only|workspace-write|danger-full-access
      //   --full-auto                                   — low-friction workspace-write alias
      //   -m / --model                                  — model selector
      //   -C / --cd <dir>                               — working root
      //   --skip-git-repo-check                         — allow non-git cwds (worktrees are fine)
      //   --ephemeral                                   — don't persist session rollout files
      //
      // Codex has its own on-disk session store; we key resumes off the
      // `thread_id` captured from the `thread.started` JSONL event (see
      // `engine_session_id` tracking in stream-parser.ts + chat event hook).
      // On the first turn we pass the enriched system prompt inline (Codex has
      // no `--system-prompt` flag) and rely on `--skip-git-repo-check` so
      // fresh project cwds without a `.git` dir don't fail.
      const isAskMode = !!session!.ask_mode;
      const prompt =
        isNewEngineSession || forceSystemPromptThisTurn
          ? `${enrichedPrompt}\n\n${finalPrompt}`
          : cliContent + imagePromptSuffix;
      args = ['exec'];
      if (!isNewEngineSession && engineSessionId) {
        args.push('resume', engineSessionId);
      }
      args.push('--json', '--skip-git-repo-check');
      if (isAskMode) {
        args.push('--sandbox', 'read-only');
      } else {
        // --full-auto = `-a on-request --sandbox workspace-write`, which is
        // the closest parity with Claude Code's bypassPermissions default.
        args.push('--full-auto');
      }
      // Auth-mode-aware --model gating. Under ChatGPT OAuth the Codex backend
      // rejects most explicit `--model` IDs (HTTP 400 "not supported when
      // using Codex with a ChatGPT account"). shouldPassModelFlag() filters
      // the model against the ChatGPT allowlist; unsupported values get
      // dropped so Codex falls back to its built-in ChatGPT default rather
      // than 400ing the turn. API-key / unknown modes keep the prior
      // pass-through behavior.
      const codexAuth = detectCodexAuthMode();
      if (model && shouldPassModelFlag(codexAuth.mode, model)) {
        args.push('--model', model);
      } else if (model) {
        console.warn(
          `[chat] Dropping --model ${model} for codex-cli session ${sessionId}: ` +
            `auth_mode=${codexAuth.mode} does not accept it. Falling back to codex default.`,
        );
      }
      args.push(prompt);
      bin = CODEX_BIN;
    } else {
      const isAskMode = !!session!.ask_mode;
      args = [
        '--print',
        '--permission-mode',
        isAskMode ? 'plan' : 'bypassPermissions',
        '--model',
        model,
        '--system-prompt',
        enrichedPrompt,
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
      ];
      if (isNewEngineSession) {
        args.push('--session-id', sessionId);
      } else {
        args.push('--resume', engineSessionId!);
      }
      args.push(finalPrompt);
      bin = CLAUDE_BIN;
    }

    const parser = createStreamParser(engine);
    let finalText = '';
    let partialFallback = '';
    let toolResultOutputs = '';
    let seq = 0;
    let errorOutput = '';
    // Accumulates error payloads that arrive on *stdout* (as JSONL for Codex /
    // Gemini) so the close handler can surface a meaningful message even when
    // stderr is empty or only contains informational noise (see
    // CODEX_STDERR_NOISE below). Examples:
    //   codex → turn.failed.error.message (HTTP 400 model-not-supported)
    //   codex → unknown `codex error: ...`
    let streamErrorMessage = '';

    /** Set once we have a complete `<delegate>...</delegate>` block in the stream — workers may start before the lead CLI exits. Synthesis still runs after close (see `synthesizeResults`). */
    let delegationWorkPromise: Promise<DelegationResult[]> | null = null;
    let delegationSafetyTimer: ReturnType<typeof setTimeout> | null = null;

    function clearDelegationSafetyTimer(): void {
      if (delegationSafetyTimer != null) {
        clearTimeout(delegationSafetyTimer);
        delegationSafetyTimer = null;
      }
    }

    function startDelegationOnce(tasks: DelegateTask[]): void {
      if (delegationWorkPromise !== null) return;
      activeDelegationSessions.add(sessionId);
      delegationSafetyTimer = setTimeout(
        () => {
          if (activeDelegationSessions.has(sessionId)) {
            console.error(
              `[Delegation] Safety timeout reached for session ${sessionId} — force-unlocking`,
            );
            handleDelegationCancel(sessionId);
            broadcast({
              type: 'delegation_error',
              sessionId,
              error: 'Delegation timed out (safety limit reached)',
            });
            drainQueue(sessionId);
          }
        },
        (config as AppConfig & { delegationSafetyTimeoutMs?: number }).delegationSafetyTimeoutMs ||
          900000,
      );

      delegationWorkPromise = handleDelegation(
        sessionId,
        assistantMsgId,
        tasks,
        enrichedAgent!,
        project,
        effectiveCwd,
      );
      void delegationWorkPromise.finally(() => {
        clearDelegationSafetyTimer();
      });
    }

    function tryKickoffDelegationFromStream(assistantAccumulated: string): void {
      if (!enrichedAgent) return;
      if (agent.role !== 'lead' || !agent.subAgents || agent.subAgents.length === 0) return;
      if (!assistantAccumulated.includes('<delegate>')) return;
      const tasks = parseDelegateBlock(assistantAccumulated);
      if (!tasks || tasks.length === 0) return;
      startDelegationOnce(tasks);
    }

    if (engine === 'claude-code') {
      const isWorktree = effectiveCwd !== project.cwd;
      const hasAgentHooks = agent.hooks && Object.keys(agent.hooks).length > 0;
      const hasMcpServers = agent.mcpServers && Object.keys(agent.mcpServers).length > 0;
      if (isWorktree || hasAgentHooks || hasMcpServers) {
        try {
          writeHooksConfig(effectiveCwd, sessionId, {
            agentHooks: agent.hooks,
            includeSystemHooks: isWorktree,
            mcpServers: agent.mcpServers,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[chat] Failed to write hooks config: ${message}`);
        }
      }
    }

    const spawnEnv: NodeJS.ProcessEnv = (() => {
      const base = buildSpawnEnv(config);
      // Reviewer agents post formal GitHub reviews via the bot identity so they
      // bypass GitHub's "can't review your own PR" rule for human-author PRs.
      if (config.botGithubToken && agent.role === 'reviewer') {
        base.GH_TOKEN = config.botGithubToken;
      }
      if (config.apiKey) {
        base.AGENT_HUB_API_KEY = config.apiKey;
      }
      base.AGENT_HUB_SESSION_ID = sessionId;
      return base;
    })();

    const proc = spawn(bin, args, {
      cwd: effectiveCwd,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const S = stmts;

    activeProcesses.set(sessionId, proc);
    if (proc.pid) {
      try {
        S.updateActiveTaskPid.run(proc.pid, sessionId);
      } catch {}
    }

    const handleEvent = (event: StreamEvent): void => {
      try {
        S.addSessionEvent.run('message', assistantMsgId, ++seq, event.type, JSON.stringify(event));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Failed to persist session_event:', message);
      }

      if (event.type === 'assistant_text') {
        const text = typeof event.text === 'string' ? event.text : JSON.stringify(event.text ?? '');
        const { next, accumulatedForKickoff } = applyAssistantTextChunkForDelegationKickoff(
          { finalText, partialFallback },
          text,
          event.partial,
        );
        finalText = next.finalText;
        partialFallback = next.partialFallback;
        try {
          S.appendActiveTaskOutput.run(finalText || partialFallback, sessionId);
        } catch {}
        tryKickoffDelegationFromStream(accumulatedForKickoff);
      }

      if (event.type === 'system' && event.gitWorktree != null) {
        try {
          S.updateSessionGitWorktreeDetected.run(event.gitWorktree ? 1 : 0, sessionId);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[chat] Failed to persist git_worktree_detected:', message);
        }
        broadcast({
          type: 'session-worktree-detected',
          sessionId,
          gitWorktree: event.gitWorktree,
        });
      }

      // Codex emits the engine-side session id inside the first `thread.started`
      // event (normalized to a `system` event by normalizeCodex). Persist it on
      // the first appearance so subsequent turns can `codex exec resume <id>`.
      if (
        engine === 'codex-cli' &&
        event.type === 'system' &&
        event.sessionId &&
        !engineSessionId
      ) {
        engineSessionId = event.sessionId;
        try {
          S.updateSessionEngineSessionId.run(event.sessionId, sessionId);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[chat] Failed to persist codex engine_session_id:', message);
        }
      }

      if (event.type === 'checkpoint' && event.uuid) {
        S.addCheckpoint.run(sessionId, assistantMsgId, event.uuid, event.turnIndex, null);
        broadcast({
          type: 'checkpoint',
          sessionId,
          uuid: event.uuid,
          turnIndex: event.turnIndex,
          messageId: assistantMsgId,
        });
      }

      if (event.type === 'tool_result' && event.output) {
        toolResultOutputs += '\n' + event.output;
      }

      // Capture upstream engine errors that arrive on stdout so the close
      // handler can surface them. For Codex the stream-parser turns a
      // `turn.failed` JSONL event into `{type:'result', isError:true, text}`
      // and an `error` event into `{type:'unknown', text:"codex error: ..."}`.
      // Without this, the close handler only sees stderr — which for Codex
      // is usually just the "Reading additional input from stdin..." notice.
      if (event.type === 'result' && event.isError && event.text) {
        if (!streamErrorMessage) streamErrorMessage = event.text;
      }
      if (
        event.type === 'unknown' &&
        typeof event.text === 'string' &&
        (event.text.startsWith('codex error:') || event.text.startsWith('codex item error:'))
      ) {
        if (!streamErrorMessage) streamErrorMessage = event.text;
      }

      // Progress-panel persistence: mirror progress_step events into the
      // session_progress table so reopening the session rehydrates the
      // ProgressPanel. Also broadcast a typed `session-progress` WS message
      // so the client can update without having to parse the raw session
      // event stream. Best-effort — failures don't block the chat turn.
      if (event.type === 'progress_step') {
        try {
          if (event.status === 'started') {
            S.addSessionProgress.run(
              sessionId,
              assistantMsgId,
              event.step,
              'started',
              event.startedAt,
              null,
            );
          } else {
            // `completed` / `failed` — close the most recent open row for
            // (session_id, step). If no matching row exists (e.g. agent
            // skipped the `started` marker), insert a one-shot row so the
            // panel still shows the outcome.
            const finishedAt = event.finishedAt ?? event.startedAt;
            const info = S.completeSessionProgress.run(
              event.status,
              finishedAt,
              sessionId,
              event.step,
            );
            if ((info as { changes?: number }).changes === 0) {
              S.addSessionProgress.run(
                sessionId,
                assistantMsgId,
                event.step,
                event.status,
                event.startedAt,
                finishedAt,
              );
            }
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[chat] Failed to persist session_progress:', message);
        }
        broadcast({
          type: 'session-progress',
          sessionId,
          messageId: assistantMsgId,
          step: event.step,
          status: event.status,
          startedAt: event.startedAt,
          finishedAt: event.finishedAt ?? null,
        });
      }

      broadcast({
        type: 'session-event',
        messageId: assistantMsgId,
        sessionId,
        seq,
        event,
      });

      if (event.type === 'assistant_text') {
        const chunkText =
          typeof event.text === 'string' ? event.text : JSON.stringify(event.text ?? '');
        broadcast({
          type: 'stream',
          messageId: assistantMsgId,
          sessionId,
          chunk: chunkText,
          content: finalText || partialFallback,
          engine,
          model,
        });
      }
    };

    // Tracks whether proc.on('error') fired before 'close'. When spawn fails
    // (e.g. ENOENT because the configured bin path doesn't exist), Node emits
    // 'error' first with a useful message, then 'close' with code=-2 (-errno
    // for ENOENT). Without this flag the close handler overwrites the useful
    // "Failed to spawn codex: spawn /usr/local/bin/codex ENOENT" error with
    // the cryptic "codex-cli exited with code -2".
    let spawnErrored = false;

    proc.stdout!.on('data', (chunk: Buffer) => {
      for (const event of parser.feed(chunk)) handleEvent(event);
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', async (code: number | null) => {
      activeProcesses.delete(sessionId);
      try {
        S.deleteActiveTask.run(sessionId);
      } catch {}

      // If spawn already failed with ENOENT/EACCES/etc, the 'error' listener
      // has already saved a clearer message. Bail out before we clobber it.
      if (spawnErrored) return;

      for (const event of parser.flush()) handleEvent(event);

      const assembled = (finalText || partialFallback).trim();

      if (code !== 0 && !assembled) {
        // Node reports `-errno` on the close event when spawn fails without
        // an 'error' listener firing first (rare, but guards against edge
        // cases). -2 = ENOENT, -13 = EACCES. Produce a message that points
        // at the actual bin path + the config key to edit, rather than the
        // cryptic "codex-cli exited with code -2".
        //
        // pickProcessErrorMessage strips known stderr noise (e.g. Codex's
        // "Reading additional input from stdin..." line) and falls back to
        // streamErrorMessage (real upstream errors captured from stdout
        // JSONL) before the generic exit-code message.
        let errorMsg = pickProcessErrorMessage({
          stderr: errorOutput,
          streamErrorMessage,
          engine,
          exitCode: code,
        });
        if (code === -2 || code === -13) {
          const configKey =
            engine === 'cursor-agent'
              ? 'cursorBin'
              : engine === 'gemini-cli'
                ? 'geminiBin'
                : engine === 'codex-cli'
                  ? 'codexBin'
                  : 'claudeBin';
          const reason = code === -2 ? 'not found (ENOENT)' : 'not executable (EACCES)';
          errorMsg =
            `${engine} binary ${reason} at ${bin}. ` +
            `Update ${configKey} in Settings (or ~/.agent-hub/data/config.json) to the correct path.`;
        }
        console.error(`[chat] ${engine} exited code=${code} session=${sessionId}`);
        console.error(`  bin: ${bin}`);
        console.error(`  cwd: ${effectiveCwd}`);
        console.error(`  args: ${JSON.stringify(args)}`);
        if (errorOutput.trim()) console.error(`  stderr:\n${errorOutput.trim()}`);
        else console.error('  stderr: <empty>');
        try {
          S.addSessionEvent.run(
            'message',
            assistantMsgId,
            ++seq,
            'error',
            JSON.stringify({ type: 'error', message: errorMsg }),
          );
        } catch {}
        saveErrorMessage(sessionId, assistantMsgId, engine, model, errorMsg);
        broadcast({
          type: 'error',
          messageId: assistantMsgId,
          sessionId,
          error: errorMsg,
        });
        if (delegationWorkPromise) {
          handleDelegationCancel(sessionId);
          delegationWorkPromise = null;
        }
        try {
          const bgTask = S.getBackgroundTaskBySession.get(sessionId) as
            | BackgroundTaskRow
            | undefined;
          if (bgTask && bgTask.status === 'running') {
            S.updateBackgroundTaskStatus.run('error', bgTask.id);
            broadcast({
              type: 'task_complete',
              taskId: bgTask.id,
              sessionId,
              agentId,
              status: 'error',
            });
          }
        } catch {}
        try {
          const np = (S as Stmts).getNoteProcessingBySession?.get(sessionId) as
            | NoteProcessingRow
            | undefined;
          if (np && (np.status === 'pending' || np.status === 'running')) {
            S.updateNoteProcessing.run('error', JSON.stringify({ error: errorMsg }), np.id);
          }
        } catch {}
        drainQueue(sessionId);
        return;
      }

      const finalContent = assembled || errorOutput.trim() || '(empty response)';

      try {
        S.addMessage.run(
          assistantMsgId,
          sessionId,
          'assistant',
          finalContent,
          engine,
          model,
          null,
          null,
        );
        S.touchSession.run(sessionId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[stream] Dropping assistant message for ${sessionId}: ${message}`);
        if (delegationWorkPromise) {
          handleDelegationCancel(sessionId);
          delegationWorkPromise = null;
        }
        drainQueue(sessionId);
        return;
      }

      if (engine === 'claude-code' && isNewEngineSession) {
        try {
          S.updateSessionEngineSessionId.run(sessionId, sessionId);
        } catch {}
      }

      const sess = S.getSession.get(sessionId) as SessionRow | undefined;
      if (sess && sess.name.startsWith('Session ') && isFirstMessage) {
        let autoName: string | undefined;

        if (hookSpecificOutput?.sessionTitle) {
          autoName = hookSpecificOutput.sessionTitle;
        }

        if (!autoName) {
          try {
            const linkedCard = (S as Stmts).getKanbanCardBySession?.get(sessionId) as
              | KanbanCardRow
              | undefined;
            if (linkedCard?.title) {
              autoName = linkedCard.title;
            }
          } catch {
            /* ignore if table doesn't exist */
          }
        }

        if (!autoName) {
          autoName = content.substring(0, 60) + (content.length > 60 ? '...' : '');
        }

        S.updateSessionName.run(autoName, sessionId);
        broadcast({
          type: 'session-updated',
          session: { ...sess, name: autoName },
        });
      }

      // Enrich the broadcast with agent + session names so push-notification
      // consumers (mobile) don't need a second round-trip to look them up.
      // `sess` was re-read above after any rename; fall back to the older
      // reference if the row is missing.
      const latestSess = (S.getSession.get(sessionId) as SessionRow | undefined) || sess;
      broadcast({
        type: 'done',
        messageId: assistantMsgId,
        sessionId,
        agentId: agent.id,
        agentName: agent.name,
        sessionName: latestSess?.name,
        message: {
          id: assistantMsgId,
          session_id: sessionId,
          role: 'assistant',
          content: finalContent,
          engine,
          model,
          created_at: new Date().toISOString(),
        },
      });

      try {
        const bgTask = S.getBackgroundTaskBySession.get(sessionId) as BackgroundTaskRow | undefined;
        if (bgTask && bgTask.status === 'running') {
          S.updateBackgroundTaskStatus.run('done', bgTask.id);
          broadcast({
            type: 'task_complete',
            taskId: bgTask.id,
            sessionId,
            agentId,
            status: 'done',
            preview: finalContent.substring(0, 200),
          });
        }
      } catch {}

      try {
        const np = (S as Stmts).getNoteProcessingBySession?.get(sessionId) as
          | NoteProcessingRow
          | undefined;
        if (np && (np.status === 'pending' || np.status === 'running')) {
          S.updateNoteProcessing.run('success', finalContent.substring(0, 1000), np.id);
        }
      } catch {}

      if (project.ahw) {
        const briefEntry = `**Chat** — User: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}\nAssistant: ${finalContent.substring(0, 200)}${finalContent.length > 200 ? '...' : ''}`;
        appendDailyNote(project.ahw, briefEntry);

        if (finalContent.length > 300) {
          const exchangeTranscript = buildTranscript(
            [
              { role: 'user' as const, content },
              { role: 'assistant' as const, content: finalContent },
            ] as unknown as MessageRow[],
            { agentName: agent.name },
          );
          summarizeTranscript(
            exchangeTranscript,
            {
              engine: engine || 'claude-code',
              model: model,
              cwd: project.cwd,
            },
            config,
          )
            .then((summary: string) => {
              if (summary && summary.trim()) {
                appendDailyNote(project.ahw, `**Session Summary** (${agent.name}):\n${summary}`);

                reconcileMemoryAfterSession(project.ahw, summary, {
                  claudeBin: config.claudeBin,
                  spawnEnv: buildSpawnEnv(config),
                  cwd: project.cwd,
                }).catch((err: unknown) => {
                  const message = err instanceof Error ? err.message : String(err);
                  console.error('[Memory Reconciliation] Post-session failed:', message);
                });
              }
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('[Auto-summarize] Failed:', message);
            });
        }
      }

      // Auto-close the linked kanban card when the agent reports the work
      // is a duplicate or already done via an `<agenthub:close-card>` block.
      // Best-effort — failures here must not affect chat, handoff, or
      // delegation. Runs before handoff/delegate because it's a pure
      // side-effect on the kanban board (the two flows are not mutually
      // exclusive, though in practice an agent emits one or the other).
      try {
        const closeTask = parseCloseCardBlock(finalContent);
        if (closeTask) {
          const projectId =
            (project as Project & { id?: string }).id ||
            (enrichedAgent as EnrichedAgent | null | undefined)?.projectId ||
            '';
          handleCardAutoClose(sessionId, closeTask, {
            stmts: stmts as Stmts,
            broadcast,
            projectId,
            author: agent.id,
          });
        }
      } catch (err) {
        console.error('[CardAutoClose] Unexpected error:', (err as Error).message);
      }

      // Skill gateway: detect a terminal <agenthub:skill> block, resolve the
      // requested skill body, and stash the resulting injection string so the
      // next user turn includes it in the system prompt.
      try {
        const rawSkillBlock = detectSkillInvokeBlock(finalContent);
        if (rawSkillBlock) {
          const paths = resolveProjectPaths(project as Project, agent as Agent);
          const injection = handleSkillInvoke({
            rawBlock: rawSkillBlock,
            paths: { skillsDir: paths.skillsDir },
            sessionId,
            stmts: stmts as Stmts,
            broadcast,
          });
          const latest = stmts.getSession.get(sessionId) as SessionRow | undefined;
          const existing = latest?.pending_skill_context?.trim() || '';
          const nextContext = existing ? `${existing}\n\n${injection}` : injection;
          stmts.updateSessionPendingSkillContext.run(nextContext, sessionId);
        }
      } catch (err) {
        console.error('[skill-invoke] Unexpected error:', (err as Error).message);
      }

      // Handoff takes precedence over delegate — if the agent emitted a
      // <handoff> block, ownership transfers to the target agent and we do
      // not run the delegate/synthesize flow for this turn. Per design,
      // <handoff> is terminal: any prose after the closing tag is dropped.
      if (enrichedAgent) {
        const detection = detectHandoffBlock(finalContent);
        if (detection.task) {
          if (delegationWorkPromise) {
            handleDelegationCancel(sessionId);
            delegationWorkPromise = null;
          }
          if (handoffHasTrailingContent(finalContent)) {
            console.warn(
              `[Handoff] Trailing content after </handoff> in session ${sessionId} — dropped (handoff is terminal).`,
            );
          }
          handleHandoff(sessionId, assistantMsgId, detection.task, enrichedAgent, project).catch(
            (err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('[Handoff] Failed:', message);
              broadcast({ type: 'handoff_error', sessionId, error: message });
            },
          );
          drainQueue(sessionId);
          return;
        }
        if (detection.present && detection.reason) {
          if (delegationWorkPromise) {
            handleDelegationCancel(sessionId);
            delegationWorkPromise = null;
          }
          // The agent emitted a <handoff> tag but the payload was malformed
          // (bad JSON, missing fields, etc.). Previously this path silently
          // dropped the handoff with no UI feedback. Now: record a failed
          // row + broadcast handoff_error so the widget renders the failure
          // state instead of leaving the user staring at a dead-air turn.
          const projectId =
            (project as Project & { id?: string }).id ||
            (enrichedAgent as EnrichedAgent & { projectId?: string }).projectId ||
            '';
          recordMalformedHandoff({
            stmts,
            broadcast,
            sessionId,
            fromAgentId: enrichedAgent.id,
            fromAgentName: enrichedAgent.name,
            projectId,
            detection,
          });
          console.warn(
            `[Handoff] Malformed <handoff> block in session ${sessionId}: ${detection.reason}`,
          );
          drainQueue(sessionId);
          return;
        }
      }

      if (agent.role === 'lead' && agent.subAgents && agent.subAgents.length > 0) {
        const delegateTasks = parseDelegateBlock(finalContent);
        const closePlan = planDelegationRoundOnProcClose({
          delegateTasks,
          hadEarlyDelegationPromise: delegationWorkPromise != null,
        });
        if (closePlan.mode === 'delegate') {
          if (closePlan.startIfNeeded) {
            startDelegationOnce(delegateTasks!);
          }

          if (delegationWorkPromise) {
            void delegationWorkPromise
              .then((results) => {
                if (results.length > 0) {
                  return synthesizeResults(
                    sessionId,
                    agentId,
                    enrichedAgent!,
                    project,
                    results,
                    content,
                    effectiveCwd,
                  );
                }
              })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                console.error('[Delegation] Failed:', message);
                broadcast({ type: 'delegation_error', sessionId, error: message });
              })
              .finally(() => {
                clearDelegationSafetyTimer();
                activeDelegationSessions.delete(sessionId);
                clearDelegationUiMeta(sessionId);
                broadcastActiveTasksSnapshot(stmts, broadcast);
                drainQueue(sessionId);
              });
          }
          return;
        }
      }

      // Isolated (git worktree) + Claude: give the filesystem a moment to settle
      // after the CLI exits before `git status` / `gh`. The old flow ran auto-commit
      // from the HTTP stop hook immediately; if git still looked clean, the hook
      // path marked the session "handled" and proc skipped — no `changes_ready`
      // / Create PR banner even with Isolated ON.
      const worktreeClaude = engine === 'claude-code' && effectiveCwd !== project.cwd;
      if (worktreeClaude) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1200));
      }
      await autoCommitAndPR(sessionId, agentId, project, agent, effectiveCwd, finalContent).catch(
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[auto-commit] Unexpected error:', message);
        },
      );

      if (autonomousProjects.size > 0) {
        setTimeout(() => tryAutonomousDispatch(), 2000);
      }

      drainQueue(sessionId);
    });

    proc.on('error', (err: Error) => {
      spawnErrored = true;
      activeProcesses.delete(sessionId);
      try {
        S.deleteActiveTask.run(sessionId);
      } catch {}
      const engineLabel =
        engine === 'cursor-agent'
          ? 'cursor agent'
          : engine === 'gemini-cli'
            ? 'gemini'
            : engine === 'codex-cli'
              ? 'codex'
              : 'claude';
      // Point the user at the correct config key. ENOENT here almost always
      // means the configured bin path is wrong (wiki: "Spawn PATH Propagation").
      const configKey =
        engine === 'cursor-agent'
          ? 'cursorBin'
          : engine === 'gemini-cli'
            ? 'geminiBin'
            : engine === 'codex-cli'
              ? 'codexBin'
              : 'claudeBin';
      const errnoCode = (err as NodeJS.ErrnoException).code;
      const hint =
        errnoCode === 'ENOENT'
          ? ` — binary not found at ${bin}. Update ${configKey} in Settings or ~/.agent-hub/data/config.json.`
          : errnoCode === 'EACCES'
            ? ` — ${bin} is not executable. Update ${configKey} or chmod +x it.`
            : '';
      const errText = `Failed to spawn ${engineLabel}: ${err.message}${hint}`;
      saveErrorMessage(sessionId, assistantMsgId, engine, model, errText);
      broadcast({
        type: 'error',
        messageId: assistantMsgId,
        sessionId,
        error: errText,
      });
      drainQueue(sessionId);
    });
  }

  return { handleChat, saveErrorMessage, createCursorChat };
}
