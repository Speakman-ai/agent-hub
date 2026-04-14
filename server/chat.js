/**
 * Chat handler module — core chat function (CLI spawning, streaming) and
 * system prompt construction extracted from index.js.
 *
 * Uses a factory/dependency-injection pattern consistent with routes/*.js.
 */

import { spawn, execFile, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { stmts } from './db.js';
import { createStreamParser } from './stream-parser.js';
import config, { defaultModelForEngine, buildSpawnEnv } from './config.js';
import { resolveProjectPaths, contextFilePath } from './project-paths.js';
import { getWikiContext } from './wiki.js';
import { getMemoryContext, appendDailyNote, reconcileMemoryAfterSession } from './memory.js';
import { collectSkillsFromDir, DEFAULT_SKILLS_DIR } from './routes/skills.js';
import { summarizeTranscript, buildTranscript } from './routes/sessions.js';
import { writeHooksConfig } from './hooks.js';
import { hookHandled, clearCompleted } from './routes/hooks.js';

const DEFAULT_MODEL = config.defaultModel;
const MAX_QUEUE_SIZE = 10;

// ─── buildEnrichedPrompt ───────────────────────────────────────────

/**
 * Build the enriched system prompt for a given agent.
 * Accepts either:
 *   - buildEnrichedPrompt(enrichedAgent)  — agent object with .ahw from allAgents()/getEnrichedAgent()
 *   - buildEnrichedPrompt(project, agent) — separate project + agent objects
 */
export function buildEnrichedPrompt(projectOrAgent, maybeAgent, options = {}) {
  let project, agent;
  if (maybeAgent) {
    project = projectOrAgent;
    agent = maybeAgent;
  } else {
    // Enriched agent (has .ahw, .cwd from project)
    agent = projectOrAgent;
    project = { cwd: agent.cwd, ahw: agent.ahw || agent.workspace };
  }

  let prompt = agent.systemPrompt || '';
  if (!project.ahw) return prompt;

  const paths = resolveProjectPaths(project, agent);

  // Add shared context files (project level) + agent identity
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

  // Add available skills list (project-level + defaults)
  {
    const projectSkills = collectSkillsFromDir(paths.skillsDir);
    const defaultSkills = collectSkillsFromDir(DEFAULT_SKILLS_DIR);
    const projectIds = new Set(projectSkills.map((s) => s.id));
    let allSkills = [...projectSkills, ...defaultSkills.filter((s) => !projectIds.has(s.id))];

    // Filter out disabled skills for this agent
    try {
      const overrides = stmts.getAgentSkillOverrides.all(agent.id);
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

  // Add wiki page list + documentation instructions
  const projectId = project.id || agent.projectId;
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

      // Kanban self-reporting instructions
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

  // Add memory context (project level — MEMORY.md + daily notes)
  const memoryContext = getMemoryContext(project.ahw);
  if (memoryContext) {
    prompt += '\n\n' + memoryContext;
  }

  // ── Full Development Lifecycle (GitHub-connected projects) ──
  // Detect if this project's cwd is a GitHub repo
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
This project is connected to GitHub. When asked to implement a change, follow this **exact lifecycle**:

### 1. Issue Tracking
- **Check** if a kanban card already exists for this work: \`GET /api/projects/${projectId}/board\`
- If no card exists, **create one** in "To Do": \`POST /api/projects/${projectId}/board/cards\` with \`{title, description, columnId: "<todo-column-id>", priority, assignee: "your-agent-name"}\`
- **Move the card to "In Progress"** when you begin work: \`POST /api/projects/${projectId}/board/cards/:cardId/move\` with \`{columnId: "<in-progress-column-id>"}\`

### 2. Sync & Branch
- **Pull latest from main** first to ensure a fresh base:
  \`\`\`bash
  git checkout main && git pull origin main
  \`\`\`
- **Create a new feature branch**: \`git checkout -b feature/<short-description>\`${options.useWorktree ? '\n- You are in a git worktree — you can pull and branch here without affecting the main repo.' : ''}
- If delegating to sub-agents, they must edit files in the **current working directory**, not the main repo.

### 3. Build Environment
${project.commands?.install ? `- **Install dependencies**: \`${project.commands.install}\`` : '- **Install dependencies** if needed (check for `package-lock.json`, `requirements.txt`, `Cargo.lock`, etc.)'}
${project.commands?.build ? `- **Verify the project builds**: \`${project.commands.build}\`` : '- **Verify the project builds** before making changes: `npm run build`, `cargo check`, etc.'}
- Skip this step if you've already built in this session and no dependencies changed.

### 4. Implement
- Make your code changes on the feature branch.
- Follow existing code patterns and conventions.

### 5. Test & Lint
${project.commands?.test ? `- **Run tests**: \`${project.commands.test}\`` : "- **Run tests** according to the project's test configuration (`npm test`, `pytest`, `cargo test`, etc.)."}
${project.commands?.lint ? `- **Run linting**: \`${project.commands.lint}\`` : "- **Run linting** according to the project's lint configuration (`npm run lint`, `eslint`, `ruff`, etc.)."}
- If tests or linting fail, **fix the issues before proceeding**.

### 6. Commit & Push
- Stage and commit your changes with a descriptive message.
- Push the branch to the remote: \`git push -u origin <branch-name>\`

### 7. Create PR
- Open a PR against main: \`gh pr create --title "<title>" --body "<description>"\`
${reviewerNote}

### 8. Watch & Fix (CI Loop)
After creating the PR, **monitor it until checks pass**:
- Wait 30 seconds, then check: \`gh pr checks <pr-number>\`
- If there are **failed checks**: read the failure logs, fix the code, commit, and push again.
- **Repeat** until all checks pass.

### 9. Review & Resolve Comments
- Wait for the lead agent (or self-review if you ARE the lead) to review the PR.
- If you are the lead implementing a change, **start a separate self-review session** to review your own PR objectively.
- If there are **review comments**: address each comment, push fixes, and resolve the threads.
- **Repeat** until there are 0 unresolved comments and all checks pass.

### 10. Flag for Human Merge
- Once the PR has passing checks and all comments are resolved, **move the kanban card to "Review"**: \`POST /api/projects/${projectId}/board/cards/:cardId/move\` with \`{columnId: "<review-column-id>"}\`
- The PR is now ready for **human review and merge**. Do NOT merge the PR yourself — a human will merge it.

### Shortcuts
- For **trivial fixes** (typos, one-line changes): you may skip kanban card creation, but still use a branch + PR.
- **Found a bug or follow-up?** Create a card in "Backlog" so it gets tracked.
- **Hit a blocker?** Add a comment to the kanban card explaining what's stuck.

### Existing PRs — Manual Fix Mode
If the user asks you to fix, update, or resolve issues on **existing PRs** (e.g., "go through each PR and resolve tests and unresolved comments", "fix CI on PR #42", "address review comments on my open PRs"), **skip the full lifecycle above**. Instead:
1. Check out the PR's branch (or work in its worktree if one exists).
2. Read the failed checks (\`gh pr checks <number>\`) and/or review comments (\`gh pr view <number> --json comments,reviews\`).
3. Fix the issues directly, commit, and push.
4. Watch until green (poll checks every 30s, fix again if needed).
5. Once clean, move on to the next PR if batching.
Do **not** create new kanban cards, new branches, or new PRs for this work — you're fixing an existing one. Do NOT merge — leave for human.

Use \`GET /api/projects/${projectId}/board\` to see column names and their IDs.`;
  } else {
    // Non-GitHub project — just git workflow instructions if in worktree
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

  // Memory instructions
  prompt += `\n\n## Memory Instructions\nYou have access to memory files in your workspace. The memory context above shows your current knowledge.\nWhen you learn something important (decisions, preferences, key facts), mention it in your response so it gets logged.`;

  // External API documentation convention — applies to all agents
  prompt += `\n\n## External API Documentation — Always Verify
When working with any external service API (GitHub, Slack, Stripe, AWS, etc.), **always search for and read the current official documentation** before implementing or debugging. Do not rely solely on training data — APIs change, and stale knowledge leads to subtle bugs.

- Consult the official documentation for the service you're integrating with
- Compare the current API contract against what the code implements
- Do this **proactively** at the start of the task — don't wait until something breaks
- This applies to new integrations, bug fixes, debugging unexpected behavior, and code review of third-party API usage`;

  // Delegation instructions for lead agents
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

/**
 * Create the handleChat function with injected dependencies from index.js.
 *
 * @param {object} deps - Dependencies from index.js module state
 * @returns {{ handleChat: Function, saveErrorMessage: Function, createCursorChat: Function }}
 */
export default function createChatHandler(deps) {
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

  // Persist an assistant error message so it survives client disconnects.
  function saveErrorMessage(sessionId, messageId, engine, model, errorText) {
    const content = `⚠️ Error: ${errorText}`;
    try {
      stmts.addMessage.run(messageId, sessionId, 'assistant', content, engine, model, null);
      stmts.touchSession.run(sessionId);
    } catch (err) {
      console.error('Failed to persist error message:', err.message);
    }
    return content;
  }

  // Run `cursor-agent create-chat` and return the new chat id on stdout.
  function createCursorChat(cwd) {
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

  async function handleChat(ws, msg) {
    const { agentId, sessionId, content, images, hookSpecificOutput } = msg;
    const attachments = images && images.length > 0 ? JSON.stringify(images) : null;

    const found = findAgent(agentId);
    if (!found) {
      if (ws) ws.send(JSON.stringify({ type: 'error', error: `Unknown agent: ${agentId}` }));
      return;
    }
    const { project, agent } = found;
    const enrichedAgent = getEnrichedAgent(agentId);

    // ── Slash-command skill injection ──────────────────────────────
    const slashResult = resolveSlashSkill(agent, content, project);
    if (slashResult?.error) {
      if (ws) ws.send(JSON.stringify({ type: 'error', sessionId, error: slashResult.error }));
      return;
    }

    let cliContent = content;
    if (slashResult) {
      const args = slashResult.userArgs || 'Please use this skill as instructed.';
      cliContent = `<skill name="${slashResult.skillName}">\n${slashResult.skillContent}\n</skill>\n\n${args}`;
    }

    // Ensure session exists
    let session = stmts.getSession.get(sessionId);
    if (!session) {
      const initialEngine = agent.engine || 'claude-code';
      stmts.createSession.run(
        sessionId,
        agentId,
        `Session ${new Date().toLocaleString()}`,
        initialEngine,
        agent.model || defaultModelForEngine(initialEngine),
        1, // use_worktree default ON
        0, // ask_mode default OFF
      );
      session = stmts.getSession.get(sessionId);
    }

    // Guard: if a task or delegation is running, queue or interrupt.
    const existingTask = stmts.getActiveTask.get(sessionId);
    const isDelegating = activeDelegationSessions.has(sessionId);

    if ((existingTask || isDelegating) && !msg._fromQueue) {
      const isInterrupt = msg.interrupt === true;

      if (!isInterrupt) {
        const currentQueue = stmts.getQueuedMessages.all(sessionId);
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

      let position;
      if (isInterrupt) {
        const minPos = stmts.getMinQueuePosition.get(sessionId);
        position = (minPos?.min_pos ?? 0) - 1;
      } else {
        const maxPos = stmts.getMaxQueuePosition.get(sessionId);
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

    // Save user message + broadcast (skip if replaying from queue — already saved)
    let userMsgId;
    if (msg._fromQueue) {
      userMsgId = msg._existingMsgId;
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

    const priorMessages = stmts.getMessages.all(sessionId).filter((m) => m.id !== userMsgId);
    const isFirstMessage = priorMessages.length === 0;

    const engine = session.engine || 'claude-code';
    const model = session.model || DEFAULT_MODEL;
    const enrichedPrompt = buildEnrichedPrompt(project, agent, {
      useWorktree: !!session.use_worktree,
      _getEnrichedAgent: getEnrichedAgent,
    });
    const assistantMsgId = uuidv4();

    // Resolve engine_session_id for resume.
    let engineSessionId = session.engine_session_id || null;
    let isNewEngineSession = !engineSessionId;

    if (engine === 'cursor-agent' && !engineSessionId) {
      try {
        engineSessionId = await createCursorChat(project.cwd);
        stmts.updateSessionEngineSessionId.run(engineSessionId, sessionId);
      } catch (err) {
        console.error(err.message);
        const errText = `Failed to create cursor chat: ${err.message}`;
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

    // Insert active_tasks row BEFORE spawning
    try {
      stmts.insertActiveTask.run(sessionId, assistantMsgId, agentId, null, content, engine, model);
    } catch (err) {
      console.error('Failed to insert active_tasks row:', err.message);
    }

    broadcast({
      type: 'thinking',
      messageId: assistantMsgId,
      sessionId,
      engine,
      model,
    });

    // For legacy sessions, re-seed the engine by flattening prior messages
    const needsHistoryBootstrap = isNewEngineSession && priorMessages.length > 0;
    const promptWithHistory = (() => {
      if (!needsHistoryBootstrap) return cliContent;
      let p = 'Previous conversation:\n';
      for (const m of priorMessages) {
        const prefix = m.role === 'user' ? 'Human' : 'Assistant';
        p += `${prefix}: ${m.content}\n\n`;
      }
      p += `Human: ${cliContent}`;
      return p;
    })();

    // Copy attached images into workspace and append file-path references
    let imagePromptSuffix = '';
    if (images && images.length > 0) {
      const imgCwd = session.worktree_path || project.cwd;
      const imgDir = path.join(imgCwd, '.agent-hub-images');
      mkdirSync(imgDir, { recursive: true });
      const imgPaths = [];
      for (const img of images) {
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

    // Spawn CLI based on engine.
    const CLAUDE_BIN = getClaudeBin();
    const CURSOR_BIN = getCursorBin();
    let args;
    let bin;
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
        engineSessionId,
        '--output-format',
        'stream-json',
        '--stream-partial-output',
      ];
      bin = CURSOR_BIN;
    } else {
      // Claude Code
      const isAskMode = !!session.ask_mode;
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
        args.push('--resume', engineSessionId);
      }
      args.push(finalPrompt);
      bin = CLAUDE_BIN;
    }

    // Stream-json parser + accumulators.
    const parser = createStreamParser(engine);
    let finalText = '';
    let partialFallback = '';
    let toolResultOutputs = '';
    let seq = 0;
    let errorOutput = '';

    // Resolve effective cwd
    let effectiveCwd = project.cwd;
    if (session.use_worktree && (session.worktree_path || isNewEngineSession)) {
      const priorWorktree = session.worktree_path;
      effectiveCwd = ensureWorktree(
        session,
        project.cwd,
        agentId,
        project.commands?.install || null,
      );
      session = stmts.getSession.get(sessionId);

      // Log cross-worktree resume — Claude Code 2.1.94+ handles this natively
      if (!isNewEngineSession && priorWorktree && priorWorktree !== effectiveCwd) {
        console.log(
          `[chat] Cross-worktree resume: session ${sessionId} moved from ${priorWorktree} → ${effectiveCwd}`,
        );
      }
    } else if (!isNewEngineSession && !session.use_worktree && session.worktree_path) {
      // Worktree was disabled but engine_session_id is preserved —
      // Claude Code 2.1.94+ resumes across worktrees, so the conversation
      // context carries over even though we're now running in project.cwd.
      console.log(
        `[chat] Resuming session ${sessionId} in project cwd (worktree disabled, cross-worktree resume)`,
      );
    }

    // Write Claude Code hooks config — agent-configured hooks + system auto-commit hooks.
    // System hooks (Stop/SubagentStop) only apply to worktree sessions.
    // Agent hooks apply to all Claude Code sessions.
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
        } catch (err) {
          console.warn(`[chat] Failed to write hooks config: ${err.message}`);
        }
      }
    }

    // Inject env vars for the spawned process
    const spawnEnv = (() => {
      const base = buildSpawnEnv(config);
      if (config.botGithubToken && reviewSessionCards.has(sessionId)) {
        base.GH_TOKEN = config.botGithubToken;
      }
      // Pass API key as env var so hooks can authenticate without writing
      // the key to disk in .claude/settings.json
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

    // Pin this stream's writes to the db handle that's active right now.
    const S = stmts;

    activeProcesses.set(sessionId, proc);
    if (proc.pid) {
      try {
        S.updateActiveTaskPid.run(proc.pid, sessionId);
      } catch {}
    }

    const handleEvent = (event) => {
      try {
        S.addSessionEvent.run('message', assistantMsgId, ++seq, event.type, JSON.stringify(event));
      } catch (err) {
        console.error('Failed to persist session_event:', err.message);
      }

      if (event.type === 'assistant_text') {
        const text = typeof event.text === 'string' ? event.text : JSON.stringify(event.text ?? '');
        if (event.partial) partialFallback += text;
        else finalText += text;
        try {
          S.appendActiveTaskOutput.run(finalText || partialFallback, sessionId);
        } catch {}
      }

      // Detect worktree status from CLI status line (workspace.git_worktree)
      if (event.type === 'system' && event.gitWorktree != null) {
        try {
          S.updateSessionGitWorktreeDetected.run(event.gitWorktree ? 1 : 0, sessionId);
        } catch (err) {
          console.warn('[chat] Failed to persist git_worktree_detected:', err.message);
        }
        broadcast({
          type: 'session-worktree-detected',
          sessionId,
          gitWorktree: event.gitWorktree,
        });
      }

      // Persist checkpoint (restore point) emitted by --replay-user-messages
      // INSERT OR IGNORE silently skips duplicates (e.g. resumed sessions)
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

    proc.stdout.on('data', (chunk) => {
      for (const event of parser.feed(chunk)) handleEvent(event);
    });

    proc.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', async (code) => {
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
          const bgTask = S.getBackgroundTaskBySession.get(sessionId);
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
        drainQueue(sessionId);
        return;
      }

      const finalContent = assembled || errorOutput.trim() || '(empty response)';

      try {
        S.addMessage.run(assistantMsgId, sessionId, 'assistant', finalContent, engine, model, null);
        S.touchSession.run(sessionId);
      } catch (err) {
        console.warn(`[stream] Dropping assistant message for ${sessionId}: ${err.message}`);
        drainQueue(sessionId);
        return;
      }

      if (engine === 'claude-code' && isNewEngineSession) {
        try {
          S.updateSessionEngineSessionId.run(sessionId, sessionId);
        } catch {}
      }

      // Auto-name session from hookSpecificOutput.sessionTitle, linked kanban card, or first message
      const sess = S.getSession.get(sessionId);
      if (sess && sess.name.startsWith('Session ') && isFirstMessage) {
        let autoName;

        // 1. Explicit sessionTitle from UserPromptSubmit hook output
        if (hookSpecificOutput?.sessionTitle) {
          autoName = hookSpecificOutput.sessionTitle;
        }

        // 2. Fallback: linked kanban card title
        if (!autoName) {
          try {
            const linkedCard = S.getKanbanCardBySession?.get(sessionId);
            if (linkedCard?.title) {
              autoName = linkedCard.title;
            }
          } catch {
            /* ignore if table doesn't exist */
          }
        }

        // 3. Fallback: first 60 chars of user message
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

      // Update background task status
      try {
        const bgTask = S.getBackgroundTaskBySession.get(sessionId);
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

      // Append to daily notes
      if (project.ahw) {
        const briefEntry = `**Chat** — User: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}\nAssistant: ${finalContent.substring(0, 200)}${finalContent.length > 200 ? '...' : ''}`;
        appendDailyNote(project.ahw, briefEntry);

        if (finalContent.length > 300) {
          const exchangeTranscript = buildTranscript(
            [
              { role: 'user', content },
              { role: 'assistant', content: finalContent },
            ],
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
            .then((summary) => {
              if (summary && summary.trim()) {
                appendDailyNote(project.ahw, `**Session Summary** (${agent.name}):\n${summary}`);

                // Post-session memory reconciliation — check if MEMORY.md needs updating
                reconcileMemoryAfterSession(project.ahw, summary, {
                  claudeBin: config.claudeBin,
                  spawnEnv: buildSpawnEnv(config),
                  cwd: project.cwd,
                }).catch((err) => {
                  console.error('[Memory Reconciliation] Post-session failed:', err.message);
                });
              }
            })
            .catch((err) => {
              console.error('[Auto-summarize] Failed:', err.message);
            });
        }
      }

      // ── Delegation detection ──
      if (agent.role === 'lead' && agent.subAgents?.length > 0) {
        const delegateTasks = parseDelegateBlock(finalContent);
        if (delegateTasks && delegateTasks.length > 0) {
          activeDelegationSessions.add(sessionId);

          const delegationSafetyTimeout = setTimeout(() => {
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
          }, config.delegationSafetyTimeoutMs || 900000);

          handleDelegation(
            sessionId,
            assistantMsgId,
            delegateTasks,
            enrichedAgent,
            project,
            effectiveCwd,
          )
            .then((results) => {
              if (results.length > 0) {
                return synthesizeResults(
                  sessionId,
                  agentId,
                  enrichedAgent,
                  project,
                  results,
                  content,
                  effectiveCwd,
                );
              }
            })
            .catch((err) => {
              console.error('[Delegation] Failed:', err.message);
              broadcast({ type: 'delegation_error', sessionId, error: err.message });
            })
            .finally(() => {
              clearTimeout(delegationSafetyTimeout);
              activeDelegationSessions.delete(sessionId);
              drainQueue(sessionId);
            });
          return; // Don't drain queue yet — delegation is in progress
        }
      }

      // ── Auto-commit & PR ──
      // For Claude Code worktrees, hooks handle auto-commit (see server/hooks.js).
      // Fall back here for non-Claude engines, non-worktree sessions, or if
      // Claude Code crashed/was killed before hooks could fire.
      const hooksWillHandle = engine === 'claude-code' && effectiveCwd !== project.cwd;
      if (hooksWillHandle) {
        // Give hooks 3s to register before falling back — hooks fire before
        // process exit, but the HTTP request may arrive after proc.on('close').
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      const handledByHook = hooksWillHandle && hookHandled(sessionId);
      if (handledByHook) {
        // Hooks ran successfully — clean up the completed entry so it doesn't
        // linger in memory until the long safety timeout expires.
        clearCompleted(sessionId);
      } else {
        if (hooksWillHandle) {
          console.log(
            `[auto-commit] Hooks did not fire for ${sessionId}, falling back to proc.on('close')`,
          );
        }
        await autoCommitAndPR(sessionId, agentId, project, agent, effectiveCwd, finalContent).catch(
          (err) => console.error('[auto-commit] Unexpected error:', err.message),
        );
      }

      // ── Review outcome ──
      const sessionForReview = stmts.getSession.get(sessionId);
      if (sessionForReview?.name?.startsWith('Review: ')) {
        handleReviewOutcome(project, sessionId, finalContent).catch((err) =>
          console.error('[Autonomous] Review outcome error:', err.message),
        );
      }

      // ── Autonomous dispatch ──
      if (autonomousProjects.size > 0) {
        setTimeout(() => tryAutonomousDispatch(), 2000);
      }

      drainQueue(sessionId);
    });

    proc.on('error', (err) => {
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
