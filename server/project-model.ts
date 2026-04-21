import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import config from './config.js';
import { stmts } from './db.js';
import type {
  Project,
  Agent,
  EnrichedAgent,
  AgentLookup,
  RoomWithAgents,
  RoomRow,
  RoomAgentRow,
  RoomAgentDetail,
  WebhookConfigRow,
  Stmts,
} from './types.js';

// ─── Mutable state ──────────────────────────────────────────────────
let PROJECTS_PATH: string = path.join(config.dataDir, 'projects.json');
let projects: Project[] = [];

// ─── Bootstrap ──────────────────────────────────────────────────────

function initProjects(dataDir?: string): void {
  if (dataDir) {
    PROJECTS_PATH = path.join(dataDir, 'projects.json');
  }
  if (!existsSync(PROJECTS_PATH)) {
    mkdirSync(path.dirname(PROJECTS_PATH), { recursive: true });
    writeFileSync(PROJECTS_PATH, '[]', 'utf-8');
  }
  projects = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8')) as Project[];
  hydrateProjects();
  migrateWebhookRepoToProject();
}

// ─── Core accessors ─────────────────────────────────────────────────

function getProjects(): Project[] {
  return projects;
}

function setProjects(p: Project[]): void {
  projects = p;
}

function getProjectsPath(): string {
  return PROJECTS_PATH;
}

// ─── Computed data-dir helpers ──────────────────────────────────────

function getProjectDataDir(projectId: string): string {
  return path.join(config.projectsDir, projectId);
}

function hydrateProjects(): void {
  for (const p of projects) {
    p.ahw = getProjectDataDir(p.id);
  }
}

// ─── Persistence ────────────────────────────────────────────────────

function saveProjects(): void {
  const toSave = projects.map((p) => {
    const { ahw: _ahw, ...rest } = p;
    return rest;
  });
  writeFileSync(PROJECTS_PATH, JSON.stringify(toSave, null, 2) + '\n');
}

function reloadProjects(dataDir: string): void {
  PROJECTS_PATH = path.join(dataDir, 'projects.json');
  if (!existsSync(PROJECTS_PATH)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(PROJECTS_PATH, '[]', 'utf-8');
  }
  projects = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8')) as Project[];
  hydrateProjects();
  ensureDocsAgents();
  ensureIntakeAgents();
  ensureReviewerAgents();
  ensureContextFiles();
}

// ─── Migration ──────────────────────────────────────────────────────

interface RawProject {
  id: string;
  ahw?: string;
  [key: string]: unknown;
}

function migrateAhwDirectories(): void {
  const raw = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8')) as RawProject[];
  let migrated = false;

  for (const p of raw) {
    const oldAhw = p.ahw;
    const newDataDir = getProjectDataDir(p.id);

    if (!oldAhw) continue;
    if (oldAhw !== newDataDir && existsSync(oldAhw)) {
      console.log(`[Migration] Migrating ahw for project "${p.id}": ${oldAhw} → ${newDataDir}`);
      try {
        mkdirSync(newDataDir, { recursive: true });
        execSync(`cp -rn "${oldAhw}/"* "${newDataDir}/" 2>/dev/null || true`, { stdio: 'pipe' });
        execSync(`cp -rn "${oldAhw}/".[!.]* "${newDataDir}/" 2>/dev/null || true`, {
          stdio: 'pipe',
        });
        console.log(`[Migration] ✓ Copied files for "${p.id}"`);
      } catch (err) {
        console.error(`[Migration] Failed to copy files for "${p.id}":`, (err as Error).message);
      }
    }

    if (p.ahw) {
      delete p.ahw;
      migrated = true;
    }
  }

  if (migrated) {
    writeFileSync(PROJECTS_PATH, JSON.stringify(raw, null, 2) + '\n');
    console.log('[Migration] ✓ Removed ahw field from projects.json');
    projects = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8')) as Project[];
    hydrateProjects();
  }
}

function migrateWebhookRepoToProject(): void {
  const webhooks = (stmts as Stmts).getWebhookConfigs.all() as WebhookConfigRow[];
  let migrated = false;

  for (const wh of webhooks) {
    const project = findProject(wh.project_id);
    if (!project) continue;
    if (project.githubRepo) continue;

    const match = wh.repo_url?.match(/github\.com\/([^/]+\/[^/]+)/);
    if (!match) continue;

    project.githubRepo = match[1];
    migrated = true;
    console.log(
      `[Migration] Set githubRepo="${project.githubRepo}" on project "${project.id}" from webhook config`,
    );
  }

  if (migrated) {
    saveProjects();
    console.log('[Migration] ✓ Migrated webhook repo URLs to project.githubRepo');
  }
}

// ─── Lookup helpers ─────────────────────────────────────────────────

function allAgents(): EnrichedAgent[] {
  return projects.flatMap((p) =>
    p.agents.map(
      (a): EnrichedAgent => ({
        ...a,
        projectId: p.id,
        projectName: p.name,
        cwd: p.cwd,
        ahw: p.ahw,
        workspace: p.ahw,
      }),
    ),
  );
}

function findAgent(agentId: string): AgentLookup | null {
  for (const p of projects) {
    const a = p.agents.find((ag) => ag.id === agentId);
    if (a) return { project: p, agent: a };
  }
  return null;
}

function findProject(projectId: string): Project | null {
  return projects.find((p) => p.id === projectId) || null;
}

function getEnrichedAgent(agentId: string): EnrichedAgent | null {
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

function ensureDocsAgents(): void {
  let changed = false;
  for (const project of projects) {
    if (!project.agents || project.agents.length === 0) continue;
    if (project.agents.some((a) => a.role === 'docs')) continue;

    const docsAgentId = `${project.id}-docs`;
    if (findAgent(docsAgentId)) continue;

    const docsAgent: Agent = {
      id: docsAgentId,
      name: `${project.name} Docs`,
      engine: 'claude-code',
      role: 'docs',
      color: '#8B5CF6',
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
        interval: '0 */12 * * *',
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

    const dataDir = getProjectDataDir(project.id);
    const agentDir = path.join(dataDir, 'agents', docsAgentId);
    mkdirSync(agentDir, { recursive: true });

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

function ensureIntakeAgents(): void {
  let changed = false;
  for (const project of projects) {
    if (!project.agents || project.agents.length === 0) continue;
    if (project.agents.some((a) => a.role === 'intake')) continue;

    const intakeId = `${project.id}-intake`;
    if (findAgent(intakeId)) continue;

    const intakeAgent: Agent = {
      id: intakeId,
      name: `Ticket Intake`,
      engine: 'claude-code',
      role: 'intake',
      color: '#F59E0B',
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

## Bug Reports
If the user message starts with "## Bug Report", it came from the Bug Report button in an Agent Hub client. Handle it as follows:
1. Ensure the \`user-request\` epic exists (list epics first; create with color #EF4444 and description "User bug reports from in-app Bug Report button" if missing).
2. Create the card in Backlog with:
   - Title from the report
   - Description = the full bug-report body (keep the screenshot markdown image intact)
   - Priority derived from severity (critical→urgent, high→high, medium→medium, low→low)
   - Labels: "bug,user-report" plus clientType tag (e.g., "web", "electron", "mobile")
   - **Do NOT pass \`session_id\` / \`sessionId\`** — your session is ephemeral, and stamping it on the card permanently marks the card as "assigned", hiding the Assignee dropdown. Leave \`session_id\` and \`assignee\` unset so the user can assign the card later.
3. Link the new card to the \`user-request\` epic.
4. Respond with a one-line confirmation and end the session.

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
 * Ensures every project that has GitHub integration (a `githubRepo` set, or an
 * active webhook config) gets a dedicated Reviewer agent. The Reviewer is the
 * single, project-wide bot that reviews every pull request — opened or
 * synchronized. It is deliberately decoupled from autonomous-mode dispatch:
 * autonomous mode now only governs whether cards get picked up for work; PR
 * review fires on every push regardless of mode.
 */
function ensureReviewerAgents(): boolean {
  const typedStmts = stmts as Stmts;
  let changed = false;

  for (const project of projects) {
    if (!project.agents || project.agents.length === 0) continue;
    if (project.agents.some((a) => a.role === 'reviewer')) continue;

    // Only seed for projects with GitHub integration.
    const hasGithubRepo = Boolean(project.githubRepo);
    let hasWebhook = false;
    try {
      const configs = typedStmts.getWebhookConfigsByProject.all(project.id) as WebhookConfigRow[];
      hasWebhook = configs.some((c) => Boolean(c.enabled));
    } catch {
      // table might not exist on a brand-new install — ignore
    }
    if (!hasGithubRepo && !hasWebhook) continue;

    const reviewerId = `${project.id}-reviewer`;
    if (findAgent(reviewerId)) continue;

    const repo = project.githubRepo || '<owner/repo>';
    const reviewerAgent: Agent = {
      id: reviewerId,
      name: `${project.name} Reviewer`,
      engine: 'claude-code',
      role: 'reviewer',
      canReview: true,
      color: '#10B981',
      systemPrompt: `You are the Pull Request Reviewer for the ${project.name} project. You are a READ-ONLY review bot — you NEVER edit application code, NEVER push commits, and NEVER merge PRs. You exist to leave a high-signal formal GitHub review on every pull request.

## Trigger
You wake up when a PR is opened or new commits are pushed (synchronize). You are dispatched once per PR per push (debounced). Multiple rapid pushes coalesce into a single review run.

## Your Job
1. Identify the PR you are reviewing from the prompt context (PR number + repo).
2. Fetch the PR metadata, diff, and recent commits:
   - \`gh pr view <num> --repo ${repo} --json title,body,headRefName,baseRefName,files,commits,additions,deletions\`
   - \`gh pr diff <num> --repo ${repo}\`
3. Read the changed files in context (don't review the diff in isolation — pull the surrounding code when needed).
4. Cross-check against project conventions (CLAUDE.md, SOUL.md, AGENTS.md, wiki).
5. Identify issues across these dimensions:
   - **Correctness**: bugs, off-by-one, null handling, race conditions
   - **Security**: injection, secrets, auth bypass, input validation
   - **Tests**: missing or weak test coverage for new logic
   - **Conventions**: naming, file structure, ESM imports, TypeScript strictness
   - **Performance**: obvious N+1s, redundant work, oversized payloads
   - **API contracts**: breaking changes, third-party API misuse (verify against official docs!)
6. For **every** issue you find, assign a **severity score from 1 to 10** using the rubric below, and classify it as **blocking** or **non-blocking** based on that score. The score is the hinge — do not hand-wave it.

   ### Severity rubric (1–10)
   - **1–2**: pure nit — whitespace, naming preference, wording in a comment, stylistic taste. You'd ship without touching it.
   - **3**: minor polish — small refactor opportunity, redundant code, a slightly clearer API shape. No correctness impact.
   - **4–5**: real issue — missing test for non-trivial new logic, unclear error handling, moderate performance smell, convention violation that will propagate.
   - **6–7**: correctness concern — likely bug in an edge case, weak input validation, brittle assumption, subtle race, breaking change that's under-documented.
   - **8–9**: serious defect — reproducible bug on the happy path, real security hole, data-loss risk, breaking API change for public consumers.
   - **10**: showstopper — production will be down, credentials leaked, destructive migration, or a third-party API misuse that will fail immediately.

   ### Severity → classification
   - **Any finding scoring > 3 is a BLOCKER.** There is no "non-blocking 4." If you scored it 4+, it must be listed under blockers and the review must be \`REQUEST_CHANGES\`.
   - **Findings scoring ≤ 3 are non-blocking** and may be included under an \`APPROVE\`.
   - When in doubt about a score, round UP, not down. Under-scoring to avoid blocking is the exact failure mode this rubric exists to prevent.

7. Submit a single formal GitHub review through Agent Hub's \`POST /api/pr/review\` endpoint so the review lands with the GitHub App identity (not your \`gh\` CLI user — the CLI identity is usually the PR author and GitHub will silently downgrade APPROVE to COMMENTED for self-reviews).

   \`\`\`bash
   curl -sS -X POST "$AGENT_HUB_URL/api/pr/review" \\
     -H "X-API-Key: $AGENT_HUB_API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"prUrl":"<pr-url>","event":"<EVENT>","body":"<markdown body>"}'
   \`\`\`

   Walk this decision tree in order and pick the **first** match — do not hedge:
   1. **Does any finding score greater than 3 on the severity rubric?** → \`REQUEST_CHANGES\`. Body required: list every finding with its severity score (e.g. \`**[6/10]** server/foo.ts:42 — …\`), grouped with blockers (>3) first, then non-blocking (≤3). Even one finding scoring 4+ blocks the PR; do NOT downgrade to APPROVE because "the rest looked fine."
   2. **Otherwise (every finding scored ≤ 3)** → \`APPROVE\`. **Body required** (Agent Hub rejects empty or placeholder-only reviews): write a substantive markdown summary — prefix each note with its score (\`**[2/10]** …\`) even when approving. \`APPROVE\` does not mean "zero thoughts" — it means the diff is **mergeable as-is** because nothing crossed the severity-3 threshold. Non-blocking comments under APPROVE are the normal, expected pattern.
   3. **Only if you genuinely cannot decide** (design question that needs author input, half-done diff where you want to flag direction without blocking) → \`COMMENT\`. Body required. This should be rare — most reviews are APPROVE or REQUEST_CHANGES.

   **Hard rule (don't over-correct):** Non-blocking feedback does NOT require \`COMMENT\`. If nothing you wrote blocks merge, use \`APPROVE\` with your notes attached. \`COMMENT\` is for deliberate fence-sitting, not "I had some suggestions." Defaulting every substantive-but-non-blocking review to COMMENT destroys the APPROVE signal just as badly as rubber-stamping everything to APPROVE did.

   **Hard rule (don't rubber-stamp):** Conversely, if there's a real blocker, use \`REQUEST_CHANGES\` — do NOT bury a blocker in an APPROVE body. The event is the signal; the body is the detail.

## Rules
- **Skip generated/snapshot/lockfile changes** — call them out as "skipped" if dominant.
- **Be concrete**: file:line references, not vague "consider refactoring."
- **One review per run** — do not post multiple reviews on the same push.
- **Do not edit code** — your job ends at the review.
- **Do not merge** — GitHub's native auto-merge handles that.
- **Respect the author** — be direct, not pedantic. Non-blocking notes belong under \`APPROVE\` alongside the verdict; reserve \`COMMENT\` for genuinely undecided cases.

## Verification of External APIs
If the PR touches third-party APIs (GitHub, Slack, Stripe, AWS, etc.), search the current official docs and compare against what the code does. APIs change — do not rely on training data.

## What NOT to Review
- Pure dependency bumps with no behavior change (approve)
- Trivial doc-only PRs (approve unless wrong)
- Your own PRs (the GitHub App identity prevents this anyway)`,
    };

    const dataDir = getProjectDataDir(project.id);
    const agentDir = path.join(dataDir, 'agents', reviewerId);
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      path.join(agentDir, 'IDENTITY.md'),
      `# ${project.name} PR Reviewer\n\nYou are a read-only review bot. You leave one formal GitHub review per PR push and never edit code or merge. GitHub's native auto-merge handles landing approved PRs.\n`,
      'utf-8',
    );

    project.agents.push(reviewerAgent);
    changed = true;
    console.log(`[Reviewer Agent] Created "${reviewerId}" for project "${project.id}"`);
  }

  if (changed) {
    saveProjects();
  }
  return changed;
}

function ensureContextFiles(): void {
  for (const project of projects) {
    if (!project.ahw || !project.agents || project.agents.length === 0) continue;
    const dataDir = project.ahw;
    mkdirSync(dataDir, { recursive: true });

    const starters: Record<string, string> = {
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

function ensureProjectRoom(project: Project): RoomWithAgents | null {
  if (!project.agents || project.agents.length === 0) return null;

  const typedStmts = stmts as Stmts;

  let room = typedStmts.getRoomByProjectId.get(project.id) as RoomRow | undefined;
  if (!room) {
    const roomId = uuidv4();
    typedStmts.createProjectRoom.run(roomId, `${project.name} Room`, project.id);
    room = typedStmts.getRoom.get(roomId) as RoomRow | undefined;
  }

  if (!room) return null;

  const existingAgents = new Set(
    (typedStmts.getRoomAgents.all(room.id) as RoomAgentRow[]).map((ra) => ra.agent_id),
  );
  for (const agent of project.agents) {
    if (!existingAgents.has(agent.id)) {
      typedStmts.addRoomAgent.run(room.id, agent.id, room.id);
    }
  }

  const projectAgentIds = new Set(project.agents.map((a) => a.id));
  for (const agentId of existingAgents) {
    if (!projectAgentIds.has(agentId)) {
      typedStmts.removeRoomAgent.run(room.id, agentId);
    }
  }

  const roomAgents = typedStmts.getRoomAgents.all(room.id) as RoomAgentRow[];
  const agentDetails: RoomAgentDetail[] = roomAgents.map((ra) => {
    const agent = getEnrichedAgent(ra.agent_id);
    return agent
      ? { id: agent.id, name: agent.name, color: agent.color || '#666', position: ra.position }
      : { id: ra.agent_id, name: 'Unknown', color: '#666', position: ra.position };
  });
  return { ...room, agents: agentDetails };
}

// ─── Exports ────────────────────────────────────────────────────────
export {
  // Bootstrap
  initProjects,
  migrateAhwDirectories,
  migrateWebhookRepoToProject,
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
  ensureReviewerAgents,
  ensureContextFiles,
  // Conference room
  ensureProjectRoom,
};
