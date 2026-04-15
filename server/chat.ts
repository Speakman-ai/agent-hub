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
import { hookHandled, clearCompleted } from './routes/hooks.js';
import type { DelegationResult } from './delegation.js';
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
  reviewSessionCards: Map<string, unknown>;
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
  handleReviewOutcome: (project: Project, sessionId: string, finalContent: string) => Promise<void>;
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

  const projectId =
    (project as ProjectWithCommands & { id?: string }).id || (agent as EnrichedAgent).projectId;
  {
    if (projectId) {
      const wikiContext = getWikiContext(projectId);
      if (wikiContext) {
        prompt += '\n\n' + wikiContext;
      }
      prompt += `\n\n## Wiki Documentation Guidelines
After completing significant work, update the project wiki to preserve institutional knowledge. This helps future agents (and humans) understand decisions, patterns, and solutions without re-discovering them.

**Before writing:**
- Search the wiki first (\`GET /api/projects/${projectId}/wiki?q=...\`) to check if a relevant page already exists.
- If a page exists on the topic, **update it** rather than creating a duplicate.
- If no relevant page exists, **create a new one** with a clear title and appropriate category.

**What to document:**
- Architecture decisions and rationale
- API endpoints, request/response formats, and auth patterns
- Code conventions, naming patterns, and file structure choices
- Bug fixes and troubleshooting steps (so the same issue isn't debugged twice)
- Setup/onboarding steps that weren't obvious
- Test patterns and testing strategies

**Categories:** general, api-docs, architecture, conventions, test-patterns, troubleshooting, onboarding

**How to write:**
- \`POST /api/projects/${projectId}/wiki\` with \`{title, content, category, updatedBy: "your-agent-name"}\`
- \`PUT /api/projects/${projectId}/wiki/:slug\` to update an existing page
- Use markdown for content. Be concise but thorough — write for a developer joining the project cold.

You don't need to document every small change. Focus on things that represent **decisions**, **patterns**, or **knowledge that would be lost** when this session ends.`;

      prompt += `\n\n## Kanban Board — Task Self-Reporting
You have access to a project kanban board via the \`kanban\` skill. **Report your work on the board** as you go:

- **Starting a task?** Create a card in "In Progress" (or move an existing one from "To Do"):
  \`POST /api/projects/${projectId}/board/cards\` with \`{title, description, columnId, priority, assignee: "your-agent-name"}\`
- **Finished?** Move the card to "Done":
  \`POST /api/projects/${projectId}/board/cards/:cardId/move\` with \`{columnId: "<done-column-id>"}\`
- **Found a bug or follow-up?** Create a card in "Backlog" so it gets tracked.
- **Hit a blocker?** Add a comment to the card explaining what's stuck.

Use \`GET /api/projects/${projectId}/board\` to see columns and their IDs. Keep card titles short and descriptive.
You don't need to create cards for trivial tasks (quick questions, one-line fixes). Focus on meaningful work items.`;
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

  if (isGitHubConnected) {
    const reviewer = agent.reviewer || project.defaultReviewer || '';
    const reviewerNote = reviewer
      ? `When creating a PR, add \`--reviewer ${reviewer}\` to the \`gh pr create\` command.`
      : '';

    prompt += `\n\n## Development Lifecycle — GitHub-Connected Project
This project is connected to GitHub. When implementing changes, follow the lifecycle below.

### Your Job (Steps 1–7)
You handle implementation, testing, and handing off to the automated review system. Once you move the card to Review, **your job is done** — the server handles the rest.

### 1. Kanban Card
- Check for an existing card: \`GET /api/projects/${projectId}/board\`
- If none exists, **create one** in "To Do": \`POST /api/projects/${projectId}/board/cards\` with \`{title, description, columnId: "<todo-column-id>", priority, assignee: "your-agent-name"}\`
- Keep **title short** (under 60 chars) and **description concise** (2-3 sentences max — what changed and why).
- **Move to "In Progress"** when you begin: \`POST /api/projects/${projectId}/board/cards/:cardId/move\` with \`{columnId: "<in-progress-column-id>"}\`

### 2. Branch
- Pull latest: \`git checkout main && git pull origin main\`
- Create feature branch: \`git checkout -b feature/<short-description>\`${options.useWorktree ? '\n- You are in a git worktree — you can pull and branch here without affecting the main repo.' : ''}

### 3. Implement
- Make your changes. Follow existing code patterns and conventions.
${project.commands?.install ? `- Install dependencies if needed: \`${project.commands.install}\`` : ''}

### 4. Test & Lint
${project.commands?.test ? `- Run tests: \`${project.commands.test}\`` : '- Run tests: `npm test`, `pytest`, `cargo test`, etc.'}
${project.commands?.lint ? `- Run linting: \`${project.commands.lint}\`` : '- Run linting: `npm run lint`, `eslint`, etc.'}
- Fix failures before proceeding.

### 5. Commit & Push
- Stage, commit with a clear message, and push: \`git push -u origin <branch-name>\`

### 6. Create PR
- \`gh pr create --title "<concise title>" --body "<description>"\`
${reviewerNote}
- PR body format:
  \`\`\`
  ## Summary
  <1-3 bullet points: what changed and why>

  ## Test plan
  <What was tested / how to verify>
  \`\`\`

### 7. CI Loop + Hand Off to Review
- Poll CI: \`gh pr checks <pr-number>\` — fix failures until green.
- **Link PR to card**: \`PUT /api/projects/${projectId}/board/cards/:cardId\` with \`{pr_url: "<pr-url>"}\`
- **Move card to "Review"**: \`POST /api/projects/${projectId}/board/cards/:cardId/move\` with \`{columnId: "<review-column-id>"}\`
- **You're done.** The server automatically triggers a lead review when the card reaches Review. Do NOT wait — move on to your next task or end the session.

### What Happens Next (Automated)
The server picks up the review automatically:
1. The lead agent reviews your PR (reads diff, checks for bugs/security/correctness)
2. If **approved**: the server submits a formal GitHub approval. If auto-merge is enabled, it merges. If not, a human merges.
3. If **changes requested**: the server submits a formal review with feedback and dispatches it back to you in a new session. Address the feedback, push fixes, and the lead will re-review automatically.
4. This loop repeats until the PR is approved and merged.

### Existing PRs — Fix Mode
If asked to fix, update, or resolve issues on **existing PRs**, skip the full lifecycle:
1. Check out the PR's branch.
2. Read failures: \`gh pr checks <number>\` and/or \`gh pr view <number> --json comments,reviews\`
3. Fix, commit, push.
4. Poll until green. Move on.
Do NOT create new cards/branches/PRs for existing PR work. Do NOT merge.

### Shortcuts
- **Trivial fixes**: skip card creation, still use branch + PR.
- **Found a bug?** Create a "Backlog" card.
- **Blocked?** Comment on the card.

Use \`GET /api/projects/${projectId}/board\` to see column IDs.`;
  } else {
    if (options.useWorktree) {
      prompt += `\n\n## Git Workflow — Worktree-First Development
You are working in a git worktree with its own feature branch. Follow these rules:
- **Never commit directly to main.** All work stays on the current feature branch.
- When asked to "commit and push", commit to the current branch and push it — do NOT push to main.
- When asked to "make a PR" or "open a PR", push the branch and create a PR against main using \`gh pr create\`.
- Main only receives code via merged PRs — never direct commits.
- If delegating to sub-agents, they must edit files in the current working directory (the worktree), not the main repo.`;
    }
  }

  prompt += `\n\n## Memory Instructions\nYou have access to memory files in your workspace. The memory context above shows your current knowledge.\nWhen you learn something important (decisions, preferences, key facts), mention it in your response so it gets logged.`;

  prompt += `\n\n## External API Documentation — Always Verify
When working with any external service API (GitHub, Slack, Stripe, AWS, etc.), **always search for and read the current official documentation** before implementing or debugging. Do not rely solely on training data — APIs change, and stale knowledge leads to subtle bugs.

- Consult the official documentation for the service you're integrating with
- Compare the current API contract against what the code implements
- Do this **proactively** at the start of the task — don't wait until something breaks
- This applies to new integrations, bug fixes, debugging unexpected behavior, and code review of third-party API usage`;

  if (agent.role === 'lead' && Array.isArray(agent.subAgents) && agent.subAgents.length > 0) {
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

    prompt += `\n\n## Delegation

You lead a team of sub-agents. When a task requires multiple specialists working in parallel, delegate by including a \`<delegate>\` block in your response:

\`\`\`
<delegate>
[{"agentId": "sub-agent-id", "task": "Detailed description of what this agent should do..."},
 {"agentId": "another-sub-id", "task": "Detailed description..."}]
</delegate>
\`\`\`

Your available sub-agents:
${subAgentDescriptions}

### Guidelines
- Only delegate when tasks genuinely benefit from parallel specialist work
- Each task description should be self-contained with full context needed to execute
- After delegation completes, you'll receive the results to synthesize for the user
- For simple questions or single-domain tasks, just answer directly without delegating
- You can delegate to one or many sub-agents as appropriate
- **IMPORTANT: Do NOT use the Agent tool for delegation.** The Agent tool's subagent_type only supports built-in types (general-purpose, Explore, Plan). Your sub-agents are custom and must be invoked via the \`<delegate>\` block above — the server handles spawning them as separate CLI processes. If you use the Agent tool with a custom subagent_type like "${agent.subAgents?.[0] || 'sub-agent-id'}", it will fail with "Agent Type not found".`;
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
    reviewSessionCards,
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
    handleReviewOutcome,
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
      stmts.addMessage.run(messageId, sessionId, 'assistant', content, engine, model, null);
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

      stmts.addMessage.run(queueMsgId, sessionId, 'user', content, null, null, attachments);
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
      stmts.addMessage.run(userMsgId, sessionId, 'user', content, null, null, attachments);
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
        imagePromptSuffix =
          '\n\n[The user has attached ' +
          (imgPaths.length === 1 ? 'an image' : `${imgPaths.length} images`) +
          '. View ' +
          (imgPaths.length === 1 ? 'it' : 'them') +
          ' using the Read tool at: ' +
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
      if (config.botGithubToken && reviewSessionCards.has(sessionId)) {
        base.GH_TOKEN = config.botGithubToken;
      }
      if (config.apiKey) {
        base.AGENT_HUB_API_KEY = config.apiKey;
      }
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
        S.addMessage.run(assistantMsgId, sessionId, 'assistant', finalContent, engine, model, null);
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

      const hooksWillHandle = engine === 'claude-code' && effectiveCwd !== project.cwd;
      if (hooksWillHandle) {
        await new Promise<void>((resolve) => setTimeout(resolve, 3000));
      }
      const handledByHook = hooksWillHandle && hookHandled(sessionId);
      if (handledByHook) {
        clearCompleted(sessionId);
      } else {
        if (hooksWillHandle) {
          console.log(
            `[auto-commit] Hooks did not fire for ${sessionId}, falling back to proc.on('close')`,
          );
        }
        await autoCommitAndPR(sessionId, agentId, project, agent, effectiveCwd, finalContent).catch(
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[auto-commit] Unexpected error:', message);
          },
        );
      }

      const sessionForReview = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (sessionForReview?.name?.startsWith('Review: ')) {
        handleReviewOutcome(project, sessionId, finalContent).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[Autonomous] Review outcome error:', message);
        });
      }

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
