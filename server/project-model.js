/**
 * project-model.js — In-memory project/agent data model and helpers.
 *
 * Owns the mutable `projects` array and `PROJECTS_PATH`, and exposes all
 * functions that read or mutate the project/agent graph. index.js (and
 * route modules) import from here instead of defining these inline.
 */
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import config from './config.js';
import { stmts } from './db.js';

// ─── Mutable state ──────────────────────────────────────────────────
let PROJECTS_PATH = path.join(config.dataDir, 'projects.json');
let projects = [];

// ─── Bootstrap ──────────────────────────────────────────────────────

/** Initialise projects.json if it doesn't exist, then load. */
function initProjects(dataDir) {
  if (dataDir) {
    PROJECTS_PATH = path.join(dataDir, 'projects.json');
  }
  if (!existsSync(PROJECTS_PATH)) {
    mkdirSync(path.dirname(PROJECTS_PATH), { recursive: true });
    writeFileSync(PROJECTS_PATH, '[]', 'utf-8');
  }
  projects = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
  hydrateProjects();
}

// ─── Core accessors ─────────────────────────────────────────────────

/** Return the current projects array (reference — mutations visible). */
function getProjects() {
  return projects;
}

/** Replace the projects array (used by config import). */
function setProjects(p) {
  projects = p;
}

/** Return the current PROJECTS_PATH. */
function getProjectsPath() {
  return PROJECTS_PATH;
}

// ─── Computed data-dir helpers ──────────────────────────────────────

/**
 * Compute the data directory for a project.
 * This replaces the old `ahw` field — no longer stored in projects.json.
 */
function getProjectDataDir(projectId) {
  return path.join(config.projectsDir, projectId);
}

/**
 * Ensure ahw is computed (not stored) on every project object.
 * Called after loading projects.json.
 */
function hydrateProjects() {
  for (const p of projects) {
    p.ahw = getProjectDataDir(p.id);
  }
}

// ─── Persistence ────────────────────────────────────────────────────

function saveProjects() {
  // Strip computed ahw field before saving — it's derived, not stored
  const toSave = projects.map((p) => {
    const { ahw: _ahw, ...rest } = p;
    return rest;
  });
  writeFileSync(PROJECTS_PATH, JSON.stringify(toSave, null, 2) + '\n');
}

/**
 * Reload projects from a (possibly new) data directory.
 * Called during org switch to load the new org's projects.json.
 */
function reloadProjects(dataDir) {
  PROJECTS_PATH = path.join(dataDir, 'projects.json');
  if (!existsSync(PROJECTS_PATH)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(PROJECTS_PATH, '[]', 'utf-8');
  }
  projects = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
  hydrateProjects();
  ensureDocsAgents();
  ensureIntakeAgents();
  ensureContextFiles();
}

// ─── Migration ──────────────────────────────────────────────────────

/**
 * Migrate old ahw directories to the new centralized location.
 * Runs once on startup — detects projects with ahw paths that differ
 * from the computed path and copies files over.
 */
function migrateAhwDirectories() {
  const raw = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
  let migrated = false;

  for (const p of raw) {
    const oldAhw = p.ahw;
    const newDataDir = getProjectDataDir(p.id);

    if (!oldAhw) continue;
    // If old ahw pointed somewhere different and that directory exists, migrate
    if (oldAhw !== newDataDir && existsSync(oldAhw)) {
      console.log(`[Migration] Migrating ahw for project "${p.id}": ${oldAhw} → ${newDataDir}`);
      // Copy recursively using cp -r (simpler than manual walk)
      try {
        mkdirSync(newDataDir, { recursive: true });
        execSync(`cp -rn "${oldAhw}/"* "${newDataDir}/" 2>/dev/null || true`, { stdio: 'pipe' });
        // Also copy hidden files/dirs
        execSync(`cp -rn "${oldAhw}/".[!.]* "${newDataDir}/" 2>/dev/null || true`, {
          stdio: 'pipe',
        });
        console.log(`[Migration] ✓ Copied files for "${p.id}"`);
      } catch (err) {
        console.error(`[Migration] Failed to copy files for "${p.id}":`, err.message);
      }
    }

    // Strip ahw from the stored project
    if (p.ahw) {
      delete p.ahw;
      migrated = true;
    }
  }

  if (migrated) {
    writeFileSync(PROJECTS_PATH, JSON.stringify(raw, null, 2) + '\n');
    console.log('[Migration] ✓ Removed ahw field from projects.json');
    // Reload and hydrate
    projects = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
    hydrateProjects();
  }
}

// ─── Lookup helpers ─────────────────────────────────────────────────

/** Return a flat array of all agents enriched with project-level fields. */
function allAgents() {
  return projects.flatMap((p) =>
    p.agents.map((a) => ({
      ...a,
      projectId: p.id,
      projectName: p.name,
      cwd: p.cwd,
      ahw: p.ahw,
      // Legacy compat: some code still checks agent.workspace
      workspace: p.ahw,
    })),
  );
}

/** Find an agent by ID, returning { project, agent } or null. */
function findAgent(agentId) {
  for (const p of projects) {
    const a = p.agents.find((ag) => ag.id === agentId);
    if (a) return { project: p, agent: a };
  }
  return null;
}

/** Find a project by ID. */
function findProject(projectId) {
  return projects.find((p) => p.id === projectId) || null;
}

/** Get an enriched agent (with project fields) by ID. */
function getEnrichedAgent(agentId) {
  const found = findAgent(agentId);
  if (!found) return null;
  const { project, agent } = found;
  return {
    ...agent,
    projectId: project.id,
    projectName: project.name,
    cwd: project.cwd,
    ahw: project.ahw,
    workspace: project.ahw,
  };
}

// ─── Auto-create helpers ────────────────────────────────────────────

/**
 * Ensure every project with agents has a "docs" agent.
 * The docs agent is a background documentation specialist that maintains
 * the project wiki as a knowledge base for all agents.
 */
function ensureDocsAgents() {
  let changed = false;
  for (const project of projects) {
    if (!project.agents || project.agents.length === 0) continue;
    // Skip if project already has a docs agent
    if (project.agents.some((a) => a.role === 'docs')) continue;

    const docsAgentId = `${project.id}-docs`;
    // Don't create if an agent with this ID already exists elsewhere
    if (findAgent(docsAgentId)) continue;

    const docsAgent = {
      id: docsAgentId,
      name: `${project.name} Docs`,
      engine: 'claude-code',
      role: 'docs',
      color: '#8B5CF6', // purple — distinct from lead/sub
      systemPrompt: `You are the Documentation Agent for the ${project.name} project. Your sole purpose is to maintain a comprehensive, up-to-date wiki that serves as a knowledge base for all agents and developers working on this project.

You are NOT a coding agent. You do not write or modify application code. You READ code, commits, PRs, and existing docs, then WRITE wiki pages.

On each run:
1. Check recent git activity: \`git log --oneline --since="24 hours ago"\`
2. Check recent merged PRs: \`gh pr list --state merged --limit 10\`
3. Read the current wiki pages to find gaps, stale content, or missing docs
4. Write or update wiki pages covering:
   - **Architecture**: System design, component relationships, data flow (use mermaid diagrams)
   - **API Docs**: Endpoints, request/response formats, authentication
   - **Data Models**: Database schema, key entities, relationships
   - **Conventions**: Naming patterns, file structure, coding standards
   - **Deployment**: How to build, deploy, and monitor
   - **Troubleshooting**: Known issues, common errors, and their fixes

Write for a developer joining the project cold. Focus on WHAT decisions were made and WHY — not just describing what code does. Use mermaid diagrams for architecture and data flows.

Wiki API:
- Search: \`GET /api/projects/${project.id}/wiki?q=...\`
- List all: \`GET /api/projects/${project.id}/wiki\`
- Create: \`POST /api/projects/${project.id}/wiki\` with \`{title, content, category, updatedBy: "${docsAgentId}"}\`
- Update: \`PUT /api/projects/${project.id}/wiki/:slug\` with \`{content, updatedBy: "${docsAgentId}"}\`

Categories: general, api-docs, architecture, conventions, test-patterns, troubleshooting, onboarding`,
      heartbeat: {
        enabled: true,
        interval: '0 */12 * * *', // every 12 hours
        prompt: `Run your heartbeat in two phases:

**Phase 1 — Recent Activity (always do this first)**
Run \`git log --oneline --since="12 hours ago"\` to see recent changes. If there are changes, search the wiki for existing pages on those topics, then create or update ONE wiki page covering the most significant change. Keep it concise — one page per run, not a full audit. If nothing changed in the last 12 hours, skip to Phase 2.

**Phase 2 — Incremental Backfill (one card per run)**
Check for the next undocumented completed ticket: \`GET /api/projects/${project.id}/board/undocumented\`
If a card is returned, document it as a wiki page:
- What was built (from the card title + description)
- Key decisions and rationale (if a session_id is linked, check that session's context)
- Patterns established or conventions introduced
- Files/areas of the codebase affected

After writing the wiki page, mark the card as documented: \`POST /api/projects/${project.id}/board/cards/{cardId}/documented\`

If no undocumented cards remain, respond "Backfill complete — all done cards documented."

Only process ONE card per run. The backfill will complete organically over multiple heartbeats.`,
      },
    };

    // Docs agent is top-level — independent peer of the lead, not a subordinate.
    // No parentAgentId, no subAgents wiring.

    // Create agent data directory
    const dataDir = getProjectDataDir(project.id);
    const agentDir = path.join(dataDir, 'agents', docsAgentId);
    mkdirSync(agentDir, { recursive: true });

    // Write IDENTITY.md
    writeFileSync(
      path.join(agentDir, 'IDENTITY.md'),
      `# ${project.name} Documentation Agent\n\nYou maintain the project wiki as a living knowledge base. You review code changes, PRs, and existing documentation to keep the wiki comprehensive and current. You write for developers joining the project cold.\n`,
      'utf-8',
    );

    project.agents.push(docsAgent);
    changed = true;
    console.log(`[Docs Agent] Created "${docsAgentId}" for project "${project.id}"`);
  }

  if (changed) {
    saveProjects();
  }
}

/**
 * Auto-create a Ticket Intake agent for projects that don't have one.
 * The intake agent ingests natural-language requests and creates tickets
 * in both the Agent Hub kanban board (Backlog) and Linear (New Issues).
 */
function ensureIntakeAgents() {
  let changed = false;
  for (const project of projects) {
    if (!project.agents || project.agents.length === 0) continue;
    if (project.agents.some((a) => a.role === 'intake')) continue;

    const intakeId = `${project.id}-intake`;
    if (findAgent(intakeId)) continue;

    const intakeAgent = {
      id: intakeId,
      name: `Ticket Intake`,
      engine: 'claude-code',
      role: 'intake',
      color: '#F59E0B', // amber — stands out as an action agent
      systemPrompt: `You are the Ticket Intake Agent for the ${project.name} project. Your job is to turn what the user tells you into structured tickets on the kanban board.

## How You Work

The user will describe bugs, features, tasks, or ideas in natural language. You:

1. **Parse** their input into a structured ticket (title, description, priority, labels)
2. **Create a kanban card** in the Backlog column on the Agent Hub board
3. **Confirm** what you created with a brief summary

## Rules

- **Default behavior**: Place tickets in Backlog unless told otherwise
- **Assignee**: Only assign if the user explicitly names someone. Otherwise leave unassigned.
- **Priority**: Infer from context (urgent language = urgent, bugs = high, features = medium, ideas = low). Default to medium.
- **Labels**: Infer appropriate labels from the content (bug, feature, enhancement, tech-debt, etc.)
- **Batch mode**: If the user gives you multiple items, create a ticket for each one
- **Be concise**: Don't ask clarifying questions unless the request is truly ambiguous. Bias toward action.
- **Epics**: If the user mentions grouping tickets under an epic, use the epic APIs to create/link them.

## Creating Kanban Cards

First, get the board columns to find the Backlog column ID:
\`\`\`bash
curl -s http://localhost:3051/api/projects/${project.id}/board | jq '.columns[] | select(.name=="Backlog") | .id'
\`\`\`

Then create the card:
\`\`\`bash
curl -s -X POST http://localhost:3051/api/projects/${project.id}/board/cards \\
  -H "Content-Type: application/json" \\
  -d '{"title": "...", "description": "...", "priority": "medium", "labels": "feature,ui", "columnId": "<backlog-column-id>", "createdBy": "${intakeId}"}'
\`\`\`

## Other Kanban APIs

- **Move card**: \`POST /api/projects/${project.id}/board/cards/:cardId/move\` with \`{columnId}\`
- **Update card**: \`PUT /api/projects/${project.id}/board/cards/:cardId\` with any fields
- **Create epic**: \`POST /api/projects/${project.id}/board/epics\` with \`{name, description, color}\`
- **Link card to epic**: \`POST /api/projects/${project.id}/board/cards/:cardId/epic\` with \`{epicId}\`
- **Add comment**: \`POST /api/projects/${project.id}/board/cards/:cardId/comments\` with \`{content, author}\`

## Confirmation Format

After creating tickets, respond with:

**Created:**
- [title] → Backlog (priority) [labels]

Keep it short. Don't repeat the full description back.`,
    };

    const dataDir = getProjectDataDir(project.id);
    const agentDir = path.join(dataDir, 'agents', intakeId);
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      path.join(agentDir, 'IDENTITY.md'),
      `# ${project.name} Ticket Intake Agent\n\nYou ingest natural-language requests and create structured tickets on the Agent Hub kanban board. You bias toward action — create the ticket first, ask questions later.\n`,
      'utf-8',
    );

    project.agents.push(intakeAgent);
    changed = true;
    console.log(`[Intake Agent] Created "${intakeId}" for project "${project.id}"`);
  }

  if (changed) {
    saveProjects();
  }
}

/**
 * Ensure every project with a data directory has starter context files.
 * Older projects predate the context files system, so they never got seeded.
 * This creates minimal starter files for any project missing them.
 */
function ensureContextFiles() {
  for (const project of projects) {
    if (!project.ahw || !project.agents || project.agents.length === 0) continue;
    const dataDir = project.ahw;
    mkdirSync(dataDir, { recursive: true });

    const starters = {
      'AGENTS.md': `# AGENTS.md - ${project.name}\n\nThis folder is home. Treat it that way.\n\n## Session Startup\n\n1. Read \`SOUL.md\` — this is who you are\n2. Read \`USER.md\` — this is who you're helping\n3. Read \`memory/YYYY-MM-DD.md\` (today + yesterday) for recent context\n4. If in a main session: Also read \`MEMORY.md\`\n`,
      'SOUL.md': `# SOUL.md - ${project.name}\n\n## Identity\n\nDescribe what this project is, its architecture, and its principles here.\n`,
      'USER.md': `# USER.md\n\n- **Name**: (your name)\n- **Timezone**: (your timezone)\n- **GitHub**: (your handle)\n\nAdd preferences and context about yourself here.\n`,
      'TOOLS.md': `# TOOLS.md - ${project.name}\n\nDocument project-specific tools, CLI commands, deployment steps, and integrations here.\n`,
      'MEMORY.md': `# MEMORY.md - ${project.name}\n\nLong-term memory for key decisions, preferences, and known issues.\n`,
    };

    let seeded = false;
    for (const [filename, content] of Object.entries(starters)) {
      const filePath = path.join(dataDir, filename);
      if (!existsSync(filePath)) {
        writeFileSync(filePath, content, 'utf-8');
        seeded = true;
      }
    }
    if (seeded) {
      console.log(`[Context Files] Seeded starter files for project "${project.id}"`);
    }
  }
}

// ─── Conference Room helpers ────────────────────────────────────────

/**
 * Ensure a project has a built-in conference room with all its agents.
 * Returns the room (with enriched agents) or null if the project has no agents.
 */
// Requires initDb() to have run first (stmts is a live binding from db.js).
function ensureProjectRoom(project) {
  if (!project.agents || project.agents.length === 0) return null;

  let room = stmts.getRoomByProjectId.get(project.id);
  if (!room) {
    const roomId = uuidv4();
    stmts.createProjectRoom.run(roomId, `${project.name} Room`, project.id);
    room = stmts.getRoom.get(roomId);
  }

  // Sync agents: ensure all project agents are in the room
  const existingAgents = new Set(stmts.getRoomAgents.all(room.id).map((ra) => ra.agent_id));
  for (const agent of project.agents) {
    if (!existingAgents.has(agent.id)) {
      stmts.addRoomAgent.run(room.id, agent.id, room.id);
    }
  }

  // Remove agents no longer in the project
  const projectAgentIds = new Set(project.agents.map((a) => a.id));
  for (const agentId of existingAgents) {
    if (!projectAgentIds.has(agentId)) {
      stmts.removeRoomAgent.run(room.id, agentId);
    }
  }

  // Return enriched room
  const roomAgents = stmts.getRoomAgents.all(room.id);
  const agentDetails = roomAgents.map((ra) => {
    const agent = getEnrichedAgent(ra.agent_id);
    return agent
      ? { id: agent.id, name: agent.name, color: agent.color, position: ra.position }
      : { id: ra.agent_id, name: 'Unknown', color: '#666', position: ra.position };
  });
  return { ...room, agents: agentDetails };
}

// ─── Exports ────────────────────────────────────────────────────────
export {
  // Bootstrap
  initProjects,
  migrateAhwDirectories,
  // State accessors
  getProjects,
  setProjects,
  getProjectsPath,
  // Core lookups
  findProject,
  findAgent,
  allAgents,
  getEnrichedAgent,
  getProjectDataDir,
  // Persistence
  saveProjects,
  reloadProjects,
  hydrateProjects,
  // Auto-create helpers
  ensureDocsAgents,
  ensureIntakeAgents,
  ensureContextFiles,
  // Conference room
  ensureProjectRoom,
};
