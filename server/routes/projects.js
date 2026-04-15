import { Router } from 'express';
import { execSync, spawn } from 'child_process';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { createStreamParser } from '../stream-parser.js';
import { buildSpawnEnv } from '../config.js';

const ANALYZE_SYSTEM_PROMPT = `You are a project analyzer for Agent Hub, an AI-powered workspace manager. Analyze the code repository at your current working directory and return structured JSON.

Your response MUST be a single valid JSON object wrapped in a \`\`\`json code fence. No other text outside the fence.

JSON schema:
{
  "techStack": {
    "languages": ["string"],
    "frameworks": ["string"],
    "tools": ["string"],
    "packageManager": "string or null"
  },
  "description": "1-2 sentence project summary",
  "agents": [
    {
      "name": "Human-readable agent name",
      "id": "kebab-case-id",
      "role": "lead | sub",
      "specialty": "Brief description of what this agent focuses on",
      "systemPrompt": "Full system prompt for this agent. Be specific about the project's tech stack, conventions, and what this agent should focus on. 2-4 paragraphs."
    }
  ],
  "commands": {
    "install": "string or null — command to install dependencies (e.g. 'npm ci', 'pip install -r requirements.txt', 'cargo build')",
    "build": "string or null — command to build the project (e.g. 'npm run build', 'cargo build --release')",
    "test": "string or null — command to run tests (e.g. 'npm test', 'pytest', 'cargo test')",
    "lint": "string or null — command to run linting (e.g. 'npm run lint', 'ruff check .', 'cargo clippy')"
  },
  "contextFiles": {
    "SOUL.md": "Content describing the project's philosophy, coding standards, and architectural principles.",
    "AGENTS.md": "Content describing the team of agents and their roles.",
    "USER.md": "Placeholder for user preferences with reasonable defaults.",
    "TOOLS.md": "Key tools, scripts, and commands found in this project.",
    "MEMORY.md": "Key architectural decisions, important file locations, and project structure."
  }
}

Guidelines for agents — LEAD + SUB-AGENT HIERARCHY:
- ALWAYS create exactly ONE lead agent first in the array with role "lead"
- The lead agent is the project coordinator — it understands the full codebase, delegates tasks to sub-agents, and synthesizes results
- The lead agent's name should be "[Project] Lead" (e.g. "MyApp Lead")
- The lead agent's systemPrompt should emphasize coordination, architecture decisions, code review, and delegation
- For small projects (single language, few files): create 1 lead + 1 sub-agent (general developer)
- For medium projects: create 1 lead + 2 sub-agents (e.g. frontend + backend, or app + testing)
- For large projects: create 1 lead + 2-3 sub-agents (e.g. frontend, backend, devops)
- Never create more than 4 agents total (1 lead + 3 subs max)
- Sub-agents have role "sub" and should be specialists for specific areas of the codebase
- Each sub-agent's systemPrompt should be detailed about their specialty and the specific tech stack they work with
- Agent IDs should be descriptive kebab-case (e.g. "myapp-lead", "myapp-frontend", "myapp-backend")

Guidelines for commands:
- Detect the install command by checking lock files: bun.lockb/bun.lock -> "bun install", pnpm-lock.yaml -> "pnpm install", yarn.lock -> "yarn install", package-lock.json -> "npm ci", package.json -> "npm install", requirements.txt -> "pip install -r requirements.txt", Cargo.toml -> "cargo build"
- Detect the build command from package.json "scripts.build", Makefile "build" target, Cargo.toml, etc.
- Detect the test command from package.json "scripts.test", Makefile "test" target, pytest.ini, Cargo.toml, etc.
- Detect the lint command from package.json "scripts.lint", .eslintrc*, ruff.toml, Cargo.toml (clippy), etc.
- Return null for any command that cannot be detected

Guidelines for contextFiles:
- SOUL.md: capture actual coding style (indentation, naming conventions, patterns observed)
- AGENTS.md: describe the lead/sub-agent team structure and how they coordinate
- TOOLS.md: list actual commands from package.json scripts, Makefile targets, etc.
- MEMORY.md: note the project structure and key directories
- All content must be specific to this project, not generic`;

const ANALYZE_USER_PROMPT = `Analyze the repository at the current working directory.

Read these files if they exist to understand the project:
- package.json, package-lock.json (Node.js)
- Cargo.toml (Rust)
- pyproject.toml, setup.py, requirements.txt (Python)
- go.mod (Go)
- Makefile, Justfile
- README.md, CLAUDE.md
- .github/workflows/ (CI)
- tsconfig.json, .eslintrc*, .prettierrc*
- docker-compose.yml, Dockerfile

Also examine the top-level directory structure and a sampling of source files to understand conventions.

Return your analysis as the JSON structure described in your instructions.`;

export default function createProjectRoutes(deps) {
  const {
    stmts,
    broadcast,
    findProject,
    findAgent,
    saveProjects,
    ensureProjectRoom,
    config,
    getProjects,
    getProjectDataDir,
    ensureDocsAgents,
    ensureIntakeAgents,
    getClaudeBin,
    setClaudeBin,
  } = deps;

  const router = Router();

  // ─── Clone a GitHub repo ─────────────────────────────────────────
  router.post('/api/projects/clone', (req, res) => {
    const { url, targetDir } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    // Derive repo name from URL
    const repoName =
      url
        .replace(/\.git$/, '')
        .split('/')
        .pop() || 'repo';
    const home = process.env.HOME || '/tmp';
    const resolvedTarget = (targetDir || path.join(home, 'projects')).replace(/^~/, home);

    // Ensure target directory exists
    mkdirSync(resolvedTarget, { recursive: true });

    const clonePath = path.join(resolvedTarget, repoName);
    const cloneId = uuidv4();

    // Check if directory already exists
    if (existsSync(clonePath)) {
      return res.status(409).json({
        error: `Directory already exists: ${clonePath}`,
        existingPath: clonePath,
        cloneId,
      });
    }

    // Spawn git clone with progress
    const proc = spawn('git', ['clone', '--progress', url, clonePath], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // git clone writes progress to stderr
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      // Parse progress lines (e.g. "Receiving objects:  42% (100/238)")
      const lines = text.split(/\r?\n|\r/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          broadcast({ type: 'clone-progress', cloneId, message: trimmed });
        }
      }
    });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) broadcast({ type: 'clone-progress', cloneId, message: text });
    });

    proc.on('error', (err) => {
      broadcast({ type: 'clone-error', cloneId, error: `Failed to start git: ${err.message}` });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        broadcast({ type: 'clone-complete', cloneId, path: clonePath, repoName });
      } else {
        // Check for common auth errors
        let errorMsg = `git clone exited with code ${code}`;
        if (stderrBuf.includes('Permission denied') || stderrBuf.includes('publickey')) {
          errorMsg = 'SSH key authentication failed. Check your SSH keys or use an HTTPS URL.';
        } else if (stderrBuf.includes('Authentication failed') || stderrBuf.includes('403')) {
          errorMsg =
            'Authentication failed. For private repos, use SSH or configure a GitHub token.';
        } else if (stderrBuf.includes('not found') || stderrBuf.includes('404')) {
          errorMsg = 'Repository not found. Check the URL and your access permissions.';
        } else if (stderrBuf.includes('already exists')) {
          errorMsg = `Directory already exists: ${clonePath}`;
        }
        broadcast({ type: 'clone-error', cloneId, error: errorMsg });
      }
    });

    // 5-minute timeout
    const timeout = setTimeout(
      () => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }, 2000);
        broadcast({ type: 'clone-error', cloneId, error: 'Clone timed out after 5 minutes' });
      },
      5 * 60 * 1000,
    );

    proc.on('close', () => clearTimeout(timeout));

    res.json({ cloneId, repoName, clonePath });
  });

  // ─── Project endpoints ────────────────────────────────────────────
  router.get('/api/projects', (_req, res) => {
    const projects = getProjects();
    // Return projects with enriched agents (activity info)
    const enriched = projects.map((p) => ({
      ...p,
      agents: p.agents.map((a) => {
        const sessions = stmts.getSessions.all(a.id);
        let lastActivity = null;
        let lastMessage = null;
        if (sessions.length > 0) {
          lastActivity = sessions[0].updated_at;
          const msg = stmts.getLastMessage.get(sessions[0].id);
          if (msg) {
            lastMessage = {
              role: msg.role,
              content: msg.content.substring(0, 100),
              created_at: msg.created_at,
            };
          }
        }
        return {
          ...a,
          projectId: p.id,
          projectName: p.name,
          cwd: p.cwd,
          ahw: p.ahw,
          lastActivity,
          lastMessage,
        };
      }),
    }));
    res.json(enriched);
  });

  // ─── Setup / first-run status ────────────────────────────────────
  router.get('/api/setup/status', (_req, res) => {
    const projects = getProjects();
    let claudeAvailable = false;

    try {
      execSync(`"${getClaudeBin()}" --version`, { timeout: 5000, stdio: 'pipe' });
      claudeAvailable = true;
    } catch {}

    res.json({
      firstRun: projects.length === 0,
      engines: {
        'claude-code': {
          available: claudeAvailable,
          path: getClaudeBin(),
        },
      },
      dataDir: config.dataDir,
      projectsDir: config.projectsDir,
    });
  });

  router.post('/api/setup/configure', (req, res) => {
    const { claudeBin } = req.body;

    // Persist to the data-dir config.json (writable in production, unlike the
    // bundled copy inside the .app). config.js prefers this path on next load.
    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {}

    if (claudeBin !== undefined) fileConfig.claudeBin = claudeBin;

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

    // Update in-memory state so already-running endpoints (analyze, chat, etc.)
    // pick up the new path immediately — no restart needed.
    if (claudeBin !== undefined) {
      setClaudeBin(claudeBin);
      config.claudeBin = claudeBin;
    }

    res.json({ ok: true, message: 'Configuration updated.' });
  });

  router.get('/api/projects/:projectId', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  router.post('/api/projects', (req, res) => {
    const projects = getProjects();
    const { id, name, cwd, color, commands } = req.body;
    if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
      return res.status(400).json({ error: 'id is required and must be alphanumeric+hyphens' });
    }
    if (findProject(id)) {
      return res.status(409).json({ error: 'Project id already exists' });
    }
    const dataDir = getProjectDataDir(id);
    const project = {
      id,
      name: name || id,
      cwd: cwd || config.defaultCwd,
      ahw: dataDir,
      color: color || '#6b7280',
      agents: [],
    };
    // Store structured commands if provided
    if (commands && typeof commands === 'object') {
      project.commands = {
        install: commands.install || null,
        build: commands.build || null,
        test: commands.test || null,
        lint: commands.lint || null,
      };
    }
    // Create data directory structure
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
    mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
    mkdirSync(path.join(dataDir, 'memory'), { recursive: true });

    projects.push(project);
    saveProjects();
    res.status(201).json(project);
  });

  router.patch('/api/projects/:projectId', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const allowed = ['name', 'cwd', 'color', 'defaultReviewer', 'githubRepo'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) project[key] = req.body[key];
    }
    // Handle structured commands update
    if (req.body.commands && typeof req.body.commands === 'object') {
      if (!project.commands) project.commands = {};
      for (const cmd of ['install', 'build', 'test', 'lint']) {
        if (req.body.commands[cmd] !== undefined) {
          project.commands[cmd] = req.body.commands[cmd] || null;
        }
      }
    }
    // Handle GitHub workflow settings update
    if (req.body.githubWorkflow && typeof req.body.githubWorkflow === 'object') {
      if (!project.githubWorkflow) project.githubWorkflow = {};
      for (const key of ['autoMerge', 'autoReview', 'waitForCI', 'waitForResolvedComments']) {
        if (req.body.githubWorkflow[key] !== undefined) {
          project.githubWorkflow[key] = !!req.body.githubWorkflow[key];
        }
      }
    }
    // Auto-create webhook config when githubRepo is set
    if (req.body.githubRepo && typeof req.body.githubRepo === 'string') {
      const repoUrl = `https://github.com/${req.body.githubRepo}`;
      const existing = stmts.getWebhookConfigByProjectAndRepo.get(project.id, repoUrl);
      if (!existing) {
        const secret = crypto.randomBytes(32).toString('hex');
        const defaultEvents = JSON.stringify([
          'pull_request.opened',
          'pull_request.closed',
          'pull_request.synchronize',
          'pull_request_review.submitted',
          'pull_request_review_comment.created',
          'check_suite.completed',
        ]);
        stmts.createWebhookConfig.run(project.id, repoUrl, secret, defaultEvents, 1);
      }
    }
    saveProjects();
    res.json(project);
  });

  router.delete('/api/projects/:projectId', (req, res) => {
    const projects = getProjects();
    const idx = projects.findIndex((p) => p.id === req.params.projectId);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });

    const project = projects[idx];

    // Clean up all project-scoped database data.
    // Foreign key cascades handle child rows (e.g. board → columns → cards → comments).
    stmts.deleteEscalationsByProject.run(project.id);
    stmts.deleteWikiPagesByProject.run(project.id);
    stmts.deleteWebhookConfigsByProject.run(project.id);
    stmts.deleteBoardsByProject.run(project.id);
    stmts.deleteThreadsByProject.run(project.id);
    stmts.deleteRoomsByProject.run(project.id);
    stmts.deleteCronsByProject.run(project.id);

    // Clean up agent-scoped data (sessions, heartbeat state)
    const agentIds = (project.agents || []).map((a) => a.id);
    for (const agentId of agentIds) {
      stmts.deleteSessionsByAgent.run(agentId);
    }

    // Remove from projects.json
    projects.splice(idx, 1);
    saveProjects();
    res.status(204).end();
  });

  // ─── Project analysis (Open Project wizard) ──────────────────────
  router.post('/api/projects/analyze', (req, res) => {
    const { cwd } = req.body;
    if (!cwd) return res.status(400).json({ error: 'cwd is required' });

    const resolvedCwd = cwd.replace(/^~/, process.env.HOME || '/tmp');
    if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
      return res.status(400).json({ error: 'Path does not exist or is not a directory' });
    }

    const analyzeId = uuidv4();

    // Spawn claude --print for one-shot analysis with streaming events so we can
    // surface live progress (which files/tools it's looking at) to the wizard.
    const CLAUDE_BIN = getClaudeBin();
    const args = [
      '--print',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      config.defaultModel,
      '--system-prompt',
      ANALYZE_SYSTEM_PROMPT,
      '--output-format',
      'stream-json',
      '--verbose', // required by claude when --print + stream-json
      ANALYZE_USER_PROMPT,
    ];

    console.log(`[analyze ${analyzeId}] spawning ${CLAUDE_BIN} in ${resolvedCwd}`);

    let proc;
    try {
      proc = spawn(CLAUDE_BIN, args, {
        cwd: resolvedCwd,
        env: buildSpawnEnv(config),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.error(`[analyze ${analyzeId}] spawn threw:`, err.message);
      return res.status(500).json({ error: `Failed to spawn claude: ${err.message}` });
    }

    // Kill the child if it runs too long
    const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      console.error(`[analyze ${analyzeId}] timed out after ${ANALYZE_TIMEOUT_MS}ms, killing`);
      try {
        proc.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 2000);
      broadcast({
        type: 'analyze-error',
        analyzeId,
        error: `Analysis timed out after ${ANALYZE_TIMEOUT_MS / 1000}s`,
      });
    }, ANALYZE_TIMEOUT_MS);

    const parser = createStreamParser('claude-code');
    let finalText = '';
    let stderr = '';

    // Build a short, human-friendly description of what a tool call is doing,
    // so the wizard can show "Reading package.json" instead of raw JSON.
    const describeToolUse = (tool, input = {}) => {
      switch (tool) {
        case 'Read':
          return `Reading ${shortPath(input.file_path)}`;
        case 'Glob':
          return `Searching for ${input.pattern || 'files'}`;
        case 'Grep':
          return `Grepping ${input.pattern || ''}${input.path ? ` in ${shortPath(input.path)}` : ''}`;
        case 'LS':
          return `Listing ${shortPath(input.path)}`;
        case 'Bash':
          return `Running: ${(input.command || '').slice(0, 80)}`;
        case 'WebFetch':
          return `Fetching ${input.url}`;
        case 'TodoWrite':
          return `Planning next steps`;
        default:
          return `Using ${tool}`;
      }
    };
    const shortPath = (p) => {
      if (!p) return '';
      const rel = p.startsWith(resolvedCwd) ? p.slice(resolvedCwd.length + 1) : p;
      return rel || p;
    };

    const handleEvent = (ev) => {
      if (ev.type === 'tool_use') {
        const message = describeToolUse(ev.tool, ev.input);
        console.log(`[analyze ${analyzeId}] ${message}`);
        broadcast({ type: 'analyze-progress', analyzeId, message });
      } else if (ev.type === 'assistant_text' && !ev.partial) {
        finalText += ev.text;
      } else if (ev.type === 'thinking') {
        broadcast({ type: 'analyze-progress', analyzeId, message: 'Thinking…' });
      } else if (ev.type === 'result' && ev.text && !finalText) {
        // Fallback: some runs only emit the final text via the result event
        finalText = ev.text;
      }
    };

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      console.error(`[analyze ${analyzeId}] process error:`, err.message);
      broadcast({
        type: 'analyze-error',
        analyzeId,
        error: `Failed to start claude (${err.code || 'ERR'}): ${err.message}`,
      });
    });

    proc.stdout.on('data', (chunk) => {
      for (const ev of parser.feed(chunk)) handleEvent(ev);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      console.error(`[analyze ${analyzeId}] stderr:`, text.trimEnd());
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (timedOut) return; // already broadcast
      for (const ev of parser.flush()) handleEvent(ev);
      console.log(
        `[analyze ${analyzeId}] exited code=${code}, finalText length=${finalText.length}`,
      );
      if (code !== 0) {
        broadcast({
          type: 'analyze-error',
          analyzeId,
          error: stderr || `Process exited with code ${code}`,
        });
        return;
      }

      // Extract JSON from ```json ... ``` fence (greedy, to survive nested ```bash inside the JSON)
      let result = null;
      const fenceMatch = finalText.match(/```json\s*([\s\S]*)```/);
      if (fenceMatch) {
        try {
          result = JSON.parse(fenceMatch[1].trim());
        } catch (_e) {
          // Try the whole output
        }
      }
      if (!result) {
        try {
          result = JSON.parse(finalText.trim());
        } catch (_e) {
          broadcast({
            type: 'analyze-error',
            analyzeId,
            error: 'Failed to parse analysis output as JSON',
          });
          return;
        }
      }

      broadcast({ type: 'analyze-complete', analyzeId, result });
    });

    // Return immediately with the analyzeId
    res.json({ analyzeId });
  });

  router.post('/api/projects/onboard', (req, res) => {
    const { project: projectData, agents: agentDefs, contextFiles, commands } = req.body;

    if (!projectData?.id || !/^[a-zA-Z0-9-]+$/.test(projectData.id)) {
      return res
        .status(400)
        .json({ error: 'Project id is required and must be alphanumeric+hyphens' });
    }
    if (findProject(projectData.id)) {
      return res.status(409).json({ error: 'Project id already exists' });
    }

    const resolvedCwd = (projectData.cwd || config.defaultCwd).replace(
      /^~/,
      process.env.HOME || '/tmp',
    );

    const dataDir = getProjectDataDir(projectData.id);
    const project = {
      id: projectData.id,
      name: projectData.name || projectData.id,
      cwd: resolvedCwd,
      ahw: dataDir,
      color: projectData.color || '#6b7280',
      agents: [],
    };
    // Store structured commands from analysis
    if (commands && typeof commands === 'object') {
      project.commands = {
        install: commands.install || null,
        build: commands.build || null,
        test: commands.test || null,
        lint: commands.lint || null,
      };
    }

    // Create data directory structure
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
    mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
    mkdirSync(path.join(dataDir, 'memory'), { recursive: true });

    // Write shared context files
    if (contextFiles) {
      for (const [filename, content] of Object.entries(contextFiles)) {
        if (content && typeof content === 'string') {
          writeFileSync(path.join(dataDir, filename), content, 'utf-8');
        }
      }
    }

    // Create agents with lead/sub hierarchy
    if (Array.isArray(agentDefs)) {
      // Identify the lead agent (first one with role "lead", or first agent if none specified)
      const leadDef =
        agentDefs.find((d) => d.role === 'lead') || (agentDefs.length > 1 ? agentDefs[0] : null);
      const subDefs = agentDefs.filter((d) => d !== leadDef);

      for (const def of agentDefs) {
        if (!def.id || !/^[a-zA-Z0-9-]+$/.test(def.id)) continue;
        if (findAgent(def.id)) continue; // skip duplicates

        const isLead = def === leadDef && agentDefs.length > 1;
        const isSub = !isLead && leadDef && agentDefs.length > 1;

        const agent = {
          id: def.id,
          name: def.name || def.id,
          engine: def.engine || 'claude-code',
          systemPrompt: def.systemPrompt || '',
          color: def.color || project.color,
          heartbeat: { enabled: false, interval: '', prompt: '' },
        };

        // Wire up lead/sub hierarchy
        if (isLead) {
          agent.role = 'lead';
          agent.subAgents = subDefs
            .filter((s) => s.id && /^[a-zA-Z0-9-]+$/.test(s.id))
            .map((s) => s.id);
        } else if (isSub) {
          agent.role = 'sub';
          agent.parentAgentId = leadDef.id;
        }

        // Create agent-specific directory
        mkdirSync(path.join(dataDir, 'agents', agent.id), { recursive: true });

        // Write IDENTITY.md if provided
        if (def.identity) {
          writeFileSync(
            path.join(dataDir, 'agents', agent.id, 'IDENTITY.md'),
            def.identity,
            'utf-8',
          );
        }

        project.agents.push(agent);
      }
    }

    // Set up GitHub repo connection if provided during onboarding
    if (projectData.githubRepo?.owner && projectData.githubRepo?.repo) {
      const { owner, repo } = projectData.githubRepo;
      const repoUrl = `https://github.com/${owner}/${repo}`;
      const defaultEvents = JSON.stringify([
        'pull_request.opened',
        'pull_request.closed',
        'pull_request.synchronize',
        'pull_request_review.submitted',
        'pull_request_review_comment.created',
        'check_suite.completed',
      ]);
      try {
        stmts.createWebhookConfig.run(
          project.id,
          repoUrl,
          null, // secret — user can set later
          defaultEvents,
          1, // enabled
        );
      } catch (err) {
        console.warn(`[Onboard] Failed to create webhook config: ${err.message}`);
      }
    }

    const projects = getProjects();
    projects.push(project);
    saveProjects();

    // Auto-create docs agent and intake agent for the new project
    ensureDocsAgents();
    ensureIntakeAgents();

    // Auto-create conference room with all project agents
    ensureProjectRoom(project);

    // Return enriched project
    const enriched = {
      ...project,
      agents: project.agents.map((a) => ({
        ...a,
        projectId: project.id,
        projectName: project.name,
        cwd: project.cwd,
        ahw: project.ahw,
      })),
    };
    res.status(201).json(enriched);
  });

  return router;
}
