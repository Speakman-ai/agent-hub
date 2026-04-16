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
  parseHandoffBlock,
  handoffHasTrailingContent,
  handleHandoff,
  buildHandoffPromptSection,
} from './handoff.js';
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

  let prompt: string = agent.systemPrompt || '';
  if (!project.ahw) return prompt;

  const paths = resolveProjectPaths(project as Project, agent as Agent);

  const contextOrder = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md'];
  for (const filename of contextOrder) {
    const filePath = contextFilePath(paths, filename);
    if (filePath && existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.trim()) {
          prompt += `\n\n## ${filename}\n${content}`;
        }
      } catch {
        /* skip */
      }
    }
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
      prompt += `\n\n## Available Skills\n${skillsList.join('\n')}`;
    }
  }

  const isFirstMessage = options.isFirstMessage !== false; // default true for backward compat

  const projectId =
    (project as ProjectWithCommands & { id?: string }).id || (agent as EnrichedAgent).projectId;
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
When creating cards: use a **concise title** (under 60 chars) summarizing the problem/task, and include **acceptance criteria** as a bulleted checklist in the description. Pass \`session_id: "$AGENT_HUB_SESSION_ID"\` to link the card to your session (this auto-renames the sidebar to the card title).`;
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

    prompt += `\n\n## Memory Instructions
You have access to memory files. The memory context above shows your current knowledge. Mention important learnings (decisions, preferences, key facts) in your response so they get logged.`;

    prompt += `\n\n## External API Documentation — Always Verify
When working with external APIs (GitHub, Slack, etc.), always consult official documentation first. Do not rely solely on training data — APIs change.`;

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

**Answer round-trip** — the user's reply arrives as a normal chat message containing a matching \`agenthub:ask:answer\` fenced block of shape \`{ "askId": "...", "answers": {questionText: value}, "annotations": {questionText: {notes?, preview?}} }\`. For single-select questions \`value\` is a string (the chosen label or free-text from "Other"); for multi-select questions \`value\` is an array of strings. \`askId\` echoes the id of the picker you emitted so you can tie the answer to the original question. Read the answers and continue.

**When not to use** — for simple yes/no or open-ended questions, just ask in prose. Don't wrap plan-approval questions; use the regular text for those.`;
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
    return new Promise((resolve, reject) => {
      execFile(CURSOR_BIN, ['create-chat'], { cwd, env: process.env }, (err, stdout, stderr) => {
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
          activeDelegationSessions.delete(sessionId);
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
    const enrichedPrompt = buildEnrichedPrompt(
      project as ProjectWithCommands,
      agent as AgentWithModel,
      {
        useWorktree: !!session!.use_worktree,
        isFirstMessage,
        sessionId,
        _getEnrichedAgent: getEnrichedAgent,
      },
    );
    const assistantMsgId = uuidv4();

    let engineSessionId: string | null = session!.engine_session_id || null;
    const isNewEngineSession = !engineSessionId;

    if (engine === 'cursor-agent' && !engineSessionId) {
      try {
        engineSessionId = await createCursorChat(project.cwd);
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
    let args: string[];
    let bin: string;
    if (engine === 'cursor-agent') {
      const prompt = isNewEngineSession
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
        if (event.partial) partialFallback += text;
        else finalText += text;
        try {
          S.appendActiveTaskOutput.run(finalText || partialFallback, sessionId);
        } catch {}
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

      for (const event of parser.flush()) handleEvent(event);

      const assembled = (finalText || partialFallback).trim();

      if (code !== 0 && !assembled) {
        const errorMsg = errorOutput.trim() || `${engine} exited with code ${code}`;
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

      broadcast({
        type: 'done',
        messageId: assistantMsgId,
        sessionId,
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

      // Handoff takes precedence over delegate — if the agent emitted a
      // <handoff> block, ownership transfers to the target agent and we do
      // not run the delegate/synthesize flow for this turn. Per design,
      // <handoff> is terminal: any prose after the closing tag is dropped.
      if (enrichedAgent) {
        const handoffTask = parseHandoffBlock(finalContent);
        if (handoffTask) {
          if (handoffHasTrailingContent(finalContent)) {
            console.warn(
              `[Handoff] Trailing content after </handoff> in session ${sessionId} — dropped (handoff is terminal).`,
            );
          }
          handleHandoff(sessionId, assistantMsgId, handoffTask, enrichedAgent, project).catch(
            (err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('[Handoff] Failed:', message);
              broadcast({ type: 'handoff_error', sessionId, error: message });
            },
          );
          drainQueue(sessionId);
          return;
        }
      }

      if (agent.role === 'lead' && agent.subAgents && agent.subAgents.length > 0) {
        const delegateTasks = parseDelegateBlock(finalContent);
        if (delegateTasks && delegateTasks.length > 0) {
          activeDelegationSessions.add(sessionId);

          const delegationSafetyTimeout = setTimeout(
            () => {
              if (activeDelegationSessions.has(sessionId)) {
                console.error(
                  `[Delegation] Safety timeout reached for session ${sessionId} — force-unlocking`,
                );
                activeDelegationSessions.delete(sessionId);
                handleDelegationCancel(sessionId);
                broadcast({
                  type: 'delegation_error',
                  sessionId,
                  error: 'Delegation timed out (safety limit reached)',
                });
                drainQueue(sessionId);
              }
            },
            (config as AppConfig & { delegationSafetyTimeoutMs?: number })
              .delegationSafetyTimeoutMs || 900000,
          );

          handleDelegation(
            sessionId,
            assistantMsgId,
            delegateTasks,
            enrichedAgent!,
            project,
            effectiveCwd,
          )
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
              clearTimeout(delegationSafetyTimeout);
              activeDelegationSessions.delete(sessionId);
              drainQueue(sessionId);
            });
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
      activeProcesses.delete(sessionId);
      try {
        S.deleteActiveTask.run(sessionId);
      } catch {}
      const errText = `Failed to spawn ${engine === 'cursor-agent' ? 'cursor agent' : 'claude'}: ${err.message}`;
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
