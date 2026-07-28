import { v4 as uuidv4 } from 'uuid';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  cpSync,
} from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import config from './config.js';
import { getDb, getStmts } from './db.js';
import { removeStaleMcpConfigFiles } from './hooks.js';
import { resolveProjectSkillsDir, setProjectSkillsDataDir } from './project-skill-paths.js';
import {
  getProjectMode,
  getWorkflowWorkspaceDir,
  isPlaceholderWorkflowCwd,
} from './project-mode.js';
import type { Project, Agent, EnrichedAgent, AgentLookup } from './types.js';
export { deleteProjectSkillsDir, resolveProjectSkillsDir } from './project-skill-paths.js';

// ─── Mutable state ──────────────────────────────────────────────────
let PROJECTS_PATH: string = path.join(config.dataDir, 'projects.json');
let projects: Project[] = [];

// ─── Bootstrap ──────────────────────────────────────────────────────

function initProjects(dataDir?: string): void {
  if (dataDir) {
    setProjectSkillsDataDir(dataDir);
    PROJECTS_PATH = path.join(dataDir, 'projects.json');
  }
  if (!existsSync(PROJECTS_PATH)) {
    mkdirSync(path.dirname(PROJECTS_PATH), { recursive: true });
    writeFileSync(PROJECTS_PATH, '[]', 'utf-8');
  }
  projects = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8')) as Project[];
  hydrateProjects();
  migrateWorkflowProjectWorkspaces();
  migrateProjectSkillDirectories();
  migrateWebhookRepoToProject();
  migrateAgentMcpServers();
  migrateStaleMcpConfigFiles();
}

/**
 * Repoint existing workflow (no-code) projects whose `cwd` is a legacy
 * placeholder (`/tmp`, empty, or `config.defaultCwd`) at their durable
 * managed workspace dir, and create it on disk. Older workflow-create
 * paths stamped `/tmp` — shared across projects, wiped on reboot — so
 * without this backfill a no-code project made before the fix keeps
 * scattering agent resources into `/tmp`. Only known placeholders are
 * touched; a cwd the user set deliberately is left alone. Persists once if
 * anything changed.
 */
function migrateWorkflowProjectWorkspaces(): void {
  let changed = false;
  for (const p of projects) {
    if (getProjectMode(p) !== 'workflow') continue;
    if (!isPlaceholderWorkflowCwd(p.cwd, config.defaultCwd)) continue;
    const workspaceDir = getWorkflowWorkspaceDir(getProjectDataDir(p.id));
    try {
      mkdirSync(workspaceDir, { recursive: true });
    } catch (err) {
      console.warn(
        `[project-model] Failed to create workflow workspace for "${p.id}": ${(err as Error).message}`,
      );
      continue;
    }
    if (p.cwd !== workspaceDir) {
      p.cwd = workspaceDir;
      changed = true;
      console.log(`[project-model] Repointed workflow project "${p.id}" cwd to ${workspaceDir}`);
    }
  }
  if (changed) {
    try {
      saveProjects();
    } catch (err) {
      console.warn(
        `[project-model] Failed to persist workflow workspace migration: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Scrub the retired `Agent.mcpServers` field out of persisted agents.
 *
 * The MCP subsystem was deleted (card 49f2e24e). Dropping the TypeScript
 * property stops new writes but does nothing to `projects.json`, which is
 * parsed with `JSON.parse` and re-serialized wholesale — unknown keys ride
 * along untouched. On an install that ever configured a per-agent server
 * that means the stored map (including any `env` values, which were kept in
 * plaintext here, unlike the encrypted per-user registry) survives every
 * boot AND is still handed to clients by the agent read routes, which
 * serialize the same objects.
 *
 * Runs on every boot, persists only when it actually removed something, so
 * the steady state is a no-op. Safe to delete once installs have aged past
 * the removal release.
 */
function migrateAgentMcpServers(): void {
  let removed = 0;
  for (const project of projects) {
    for (const agent of project.agents || []) {
      const raw = agent as unknown as Record<string, unknown>;
      if (raw.mcpServers === undefined) continue;
      delete raw.mcpServers;
      removed++;
    }
  }
  if (removed === 0) return;
  try {
    saveProjects();
    console.log(
      `[Migration] ✓ Removed retired mcpServers config from ${removed} agent(s) in projects.json`,
    );
  } catch (err) {
    console.warn(`[project-model] Failed to persist mcpServers scrub: ${(err as Error).message}`);
  }
}

/**
 * Remove plaintext MCP config files left in known project and session
 * worktrees by the retired Claude spawn path. The session table retains the
 * worktree cwd even after a session ends, so it gives the upgrade migration a
 * bounded list of historical worktrees to clean without recursively walking
 * arbitrary user directories.
 *
 * The operation is intentionally best-effort and idempotent. A missing or
 * inaccessible worktree must not prevent the server from starting.
 */
function migrateStaleMcpConfigFiles(): void {
  const cwds = projects.map((project) => project.cwd).filter(Boolean);
  try {
    const rows = getDb()
      .prepare('SELECT worktree_path FROM sessions WHERE worktree_path IS NOT NULL')
      .all() as Array<{ worktree_path: string | null }>;
    cwds.push(...rows.map((row) => row.worktree_path).filter((cwd): cwd is string => Boolean(cwd)));
  } catch {
    // Fresh/legacy databases may not have the sessions table yet.
  }
  removeStaleMcpConfigFiles(cwds);
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

/**
 * The single source of truth for a project's **writable** skills directory
 * (`<active data dir>/project-skills/<projectId>`). Every project-skill read and write path must
 * derive the directory through here so the list endpoint never disagrees with
 * the create/update/delete endpoints.
 *
 * This intentionally lives under the central Hub data dir rather than the
 * operational project workspace (`project.ahw`). Hosted/restart flows may
 * recreate workspace directories, but project-authored skills are user data and
 * must survive with the rest of the instance state.
 */
function resolveLegacyProjectSkillsDir(project: { id: string; ahw?: string }): string {
  const base = project.ahw || (project.id ? getProjectDataDir(project.id) : '');
  return base ? path.join(base, 'skills') : '';
}

function copyMissingDirectoryEntries(srcDir: string, destDir: string): boolean {
  if (!existsSync(srcDir)) return false;
  mkdirSync(destDir, { recursive: true });
  let copied = false;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (existsSync(dest)) continue;
    cpSync(src, dest, { recursive: true });
    copied = true;
  }
  return copied;
}

function migrateProjectSkillDirectories(): void {
  for (const project of projects) {
    const canonicalDir = resolveProjectSkillsDir(project);
    const legacyDir = resolveLegacyProjectSkillsDir(project);
    if (!canonicalDir || !legacyDir || canonicalDir === legacyDir) continue;
    try {
      if (copyMissingDirectoryEntries(legacyDir, canonicalDir)) {
        console.log(
          `[skills] Migrated project skills for "${project.id}" from ${legacyDir} to ${canonicalDir}`,
        );
      }
    } catch (err) {
      console.warn(
        `[skills] Failed to migrate project skills for "${project.id}": ${(err as Error).message}`,
      );
    }
  }
}

function hydrateProjects(): void {
  for (const p of projects) {
    p.ahw = getProjectDataDir(p.id);
  }
  warnOnMissingProjectCwds();
}

// Surface projects whose `cwd` doesn't exist on this host/container at boot.
// We don't auto-create here — chat.ts has a lazy pre-spawn ensure step that
// is the actual self-heal — but logging at startup makes misconfigurations
// (e.g. host-style paths inside an ECR container) visible immediately
// instead of only failing on the user's first chat turn.
function warnOnMissingProjectCwds(): void {
  for (const p of projects) {
    if (!p.cwd) continue;
    if (!existsSync(p.cwd)) {
      console.warn(
        `[project-model] project "${p.id}" cwd does not exist: ${p.cwd} ` +
          `(will be auto-created on first chat spawn; update projects.json or Settings → Project to silence)`,
      );
    }
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
  setProjectSkillsDataDir(dataDir);
  PROJECTS_PATH = path.join(dataDir, 'projects.json');
  if (!existsSync(PROJECTS_PATH)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(PROJECTS_PATH, '[]', 'utf-8');
  }
  projects = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8')) as Project[];
  hydrateProjects();
  migrateWorkflowProjectWorkspaces();
  migrateProjectSkillDirectories();
  migrateAgentMcpServers();
  migrateStaleMcpConfigFiles();
  // Auto-seeding Docs/Intake/Reviewer on reload is deprecated alongside the
  // sub-agent model (see CLAUDE.md "Flat Agent Model"). Context files are
  // still seeded so projects always have SOUL.md/AGENTS.md/etc. on disk.
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

/**
 * One-shot upgrade migration: copy a project's GitHub repo association out of
 * the legacy `webhook_configs.repo_url` column into `project.githubRepo`.
 *
 * GitHub App + inbound-webhook infrastructure was removed (PR #149). Before
 * that, a project's GitHub repo could live ONLY in `webhook_configs` (set when
 * the operator registered an inbound webhook and never mirrored to
 * `project.githubRepo`). The webhook read path is gone, so an instance
 * upgrading from a webhook-era config would otherwise silently lose its repo
 * association — and with it reviewer seeding, since `ensureReviewerAgents`
 * keys off `project.githubRepo`.
 *
 * The legacy `webhook_configs` table is intentionally retained in the DB
 * bootstrap (see server/db.ts) precisely so this migration has something to
 * read on upgrade. We read it raw here rather than via a prepared statement
 * because the rest of the webhook DB layer was deleted with the feature.
 *
 * Runs on every boot but is idempotent: it never overwrites an existing
 * `project.githubRepo`, so once a project has the field the migration is a
 * no-op. Resilient to the table being absent on a brand-new install.
 */
function migrateWebhookRepoToProject(): void {
  let rows: Array<{ project_id: string; repo_url: string | null }> = [];
  try {
    rows = getDb()
      .prepare('SELECT project_id, repo_url FROM webhook_configs ORDER BY created_at DESC')
      .all() as Array<{ project_id: string; repo_url: string | null }>;
  } catch {
    // Legacy table missing (fresh install) — nothing to migrate.
    return;
  }

  let migrated = false;
  for (const wh of rows) {
    const project = findProject(wh.project_id);
    if (!project) continue;
    if (project.githubRepo) continue;

    // Accept both web/HTTPS (github.com/owner/repo) and SSH
    // (git@github.com:owner/repo) URL shapes, with an optional `.git` clone
    // suffix. Downstream GitHub calls + project UI expect a normalized
    // `owner/repo`, so strip a trailing `.git` rather than letting it leak
    // into `project.githubRepo` (e.g. a clone URL like
    // https://github.com/acme/widgets.git must migrate to "acme/widgets").
    const match = wh.repo_url?.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?(?:[/?#]|$)/);
    if (!match) continue;

    project.githubRepo = match[1];
    migrated = true;
    console.log(
      `[Migration] Set githubRepo="${project.githubRepo}" on project "${project.id}" from legacy webhook config`,
    );
  }

  if (migrated) {
    saveProjects();
    console.log('[Migration] ✓ Migrated legacy webhook repo URLs to project.githubRepo');
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

/**
 * RETIREMENT SWEEP — "Ticket Intake" agents (role: 'intake') are decommissioned
 * platform-wide. They are no longer auto-created (this function never seeds),
 * AND any pre-existing intake agent left in a project's roster is purged here
 * so legacy projects stop exposing and running their old Ticket Intake agents.
 *
 * Runs on startup (server/index.ts) and is re-invoked on project create /
 * onboard (server/routes/projects.ts) as an idempotent global sweep — the same
 * iterate-all-projects pattern as `ensureDocsAgents`. Mirrors the hard-delete
 * cleanup in the `DELETE /api/agents/:id` handler: it wipes every child DB row
 * keyed by the agent (sessions cascade messages/skill_invocations/etc. via FK
 * ON DELETE CASCADE), removes the on-disk workspace, then drops the agent (and
 * any stale sub-agent refs) from projects.json.
 *
 * Intake agents carry no heartbeat config, so there is no scheduled task to
 * unschedule here (and importing `heartbeat.js` would introduce an import
 * cycle). If a DB wipe fails for an agent, its roster entry is intentionally
 * left in place so the next sweep retries rather than orphaning child rows.
 */
function retireIntakeAgents(): void {
  let changed = false;
  for (const project of projects) {
    const intakeAgents = (project.agents || []).filter((a) => a.role === 'intake');
    if (intakeAgents.length === 0) continue;

    const removedIds = new Set<string>();
    for (const agent of intakeAgents) {
      const agentId = agent.id;

      // 1. Atomically wipe every child row keyed by this agent.
      try {
        const stmts = getStmts();
        getDb().transaction(() => {
          stmts.deleteSessionsByAgent.run(agentId);
          stmts.deleteHeartbeatLogsByAgent.run(agentId);
          stmts.deleteSlackMessagesByAgent.run(agentId);
          stmts.deleteSessionAgentsByAgent.run(agentId);
          stmts.deleteActiveTasksByAgent.run(agentId);
          stmts.deleteAgentSkillOverridesByAgent.run(agentId);
        })();
      } catch (e) {
        console.error(
          `[Intake Retire] DB cleanup failed for "${agentId}"; leaving roster entry for a later sweep:`,
          e,
        );
        continue;
      }

      // 2. Best-effort: remove the on-disk agent workspace.
      try {
        const agentDir = path.join(getProjectDataDir(project.id), 'agents', agentId);
        if (existsSync(agentDir)) {
          rmSync(agentDir, { recursive: true, force: true });
        }
      } catch (e) {
        console.error(`[Intake Retire] workspace removal failed for "${agentId}":`, e);
      }

      removedIds.add(agentId);
      console.log(
        `[Intake Retire] Removed retired intake agent "${agentId}" from project "${project.id}"`,
      );
    }

    if (removedIds.size === 0) continue;

    // 3. Drop the retired agents from the roster + clean stale sub-agent refs.
    project.agents = (project.agents || []).filter((a) => !removedIds.has(a.id));
    for (const a of project.agents) {
      if (Array.isArray(a.subAgents)) {
        a.subAgents = a.subAgents.filter((sid) => !removedIds.has(sid));
      }
    }
    changed = true;
  }

  if (changed) {
    saveProjects();
  }
}

/**
 * Legacy hook — skill authoring now uses `session_mode = 'skill-builder'` on any
 * dev agent (see `skill-builder-mode-prompt.ts`). Kept as a no-op so existing
 * callers and backfill migrations remain safe to invoke.
 */
function ensureSkillBuilderAgents(_projectId?: string): void {
  // Intentionally empty — do not seed `{projectId}-skill-builder` agents.
}

/**
 * Ensures every project that has GitHub integration (a `githubRepo` set) gets a
 * dedicated Reviewer agent. The Reviewer is the single, project-wide review
 * advisor used by the Finalize review phase: it inspects the local diff and
 * emits an in-session verdict (it does NOT post formal reviews to GitHub). It
 * is deliberately decoupled from autonomous-mode dispatch.
 */
function ensureReviewerAgents(opts: { onlyHosted?: boolean } = {}): boolean {
  let changed = false;

  for (const project of projects) {
    // `onlyHosted` scopes a run to Agent Hub-hosted projects (boot +
    // hosting-enable callers) so the deprecated retroactive backfill for
    // plain GitHub projects stays off.
    if (opts.onlyHosted && project.gitHost !== 'agenthub') continue;
    if (!project.agents || project.agents.length === 0) continue;
    if (project.agents.some((a) => a.role === 'reviewer')) continue;

    // Seed for projects with a review surface: GitHub integration or Agent Hub
    // git hosting (the Finalize review phase and native PR reviews both need
    // the project Reviewer).
    const hasGithubRepo = Boolean(project.githubRepo);
    const hostedOnHub = project.gitHost === 'agenthub';
    if (!hasGithubRepo && !hostedOnHub) continue;

    const reviewerId = `${project.id}-reviewer`;
    if (findAgent(reviewerId)) continue;

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
1. Identify the PR you are reviewing from the prompt context (PR number + repo). \`GH_REPO\` is injected on dispatch.
2. Fetch the PR metadata, diff, and changed files via the **github** skill wrappers (reviewer spawns have no \`GH_TOKEN\`; bare \`gh pr …\` will fail):
   - \`./gh-pr.sh view <num>\`
   - \`./gh-pr.sh diff <num>\`
   - \`./gh-pr.sh files <num>\`
   Or curl \`$AGENT_HUB_URL/api/pr/{data,diff,files}?owner=…&repo=…&number=…\` with \`X-API-Key: $AGENT_HUB_API_KEY\`.
   If you cannot load the PR diff, stop — do **not** review \`main\` or the PR description as a substitute.
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

7. Emit your verdict **in-session** — Agent Hub no longer posts formal reviews to GitHub. Write your review as a normal message (prose first), then end your turn with a SINGLE structured tail block and nothing after it:

   \`\`\`
   <agenthub:review-verdict>
   {
     "verdict": "approved" | "changes_requested",
     "threads": [
       {"file_path": "server/foo.ts", "line_start": 42, "line_end": 45, "body": "**[6/10]** ..."}
     ]
   }
   </agenthub:review-verdict>
   \`\`\`

   Walk this decision tree in order and pick the **first** match:
   1. **Does any finding score greater than 3 on the severity rubric?** → \`"changes_requested"\`. List every finding with its severity score (e.g. \`**[6/10]** server/foo.ts:42 — …\`) as a thread, blockers (>3) first, then non-blocking (≤3). Even one finding scoring 4+ blocks the PR; do NOT downgrade to approved because "the rest looked fine."
   2. **Otherwise (every finding scored ≤ 3, including "CI still running but diff looks fine")** → \`"approved"\`. Still write a substantive prose summary — prefix each note with its score (\`**[2/10]** …\`). \`approved\` does not mean "zero thoughts" — it means the diff is **mergeable as-is** because nothing crossed the severity-3 threshold. Non-blocking notes (nits, style, "CI pending") still count as approval.

   **Hard rule (don't rubber-stamp):** If there's a real blocker, use \`"changes_requested"\` — do NOT bury a blocker in an approved verdict. The verdict is the signal; the threads are the detail. Always include the tail block; \`threads\` may be empty when there is genuinely nothing worth flagging.

## Rules
- **Skip generated/snapshot/lockfile changes** — call them out as "skipped" if dominant.
- **Be concrete**: file:line references, not vague "consider refactoring."
- **One verdict per run** — emit a single structured tail block.
- **Do not edit code** — your job ends at the review.
- **Do not merge** — merging is a human action.
- **Respect the author** — be direct, not pedantic. Non-blocking notes belong alongside an \`approved\` verdict.

## Verification of External APIs
If the diff touches third-party APIs (GitHub, Slack, Stripe, AWS, etc.), search the current official docs and compare against what the code does. APIs change — do not rely on training data.

## What NOT to Review
- Pure dependency bumps with no behavior change (approve)
- Trivial doc-only PRs (approve unless wrong)`,
    };

    const dataDir = getProjectDataDir(project.id);
    const agentDir = path.join(dataDir, 'agents', reviewerId);
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      path.join(agentDir, 'IDENTITY.md'),
      `# ${project.name} PR Reviewer\n\nYou are a read-only review advisor for the Finalize review phase. You inspect the local diff and emit a single in-session verdict (approved / changes_requested). You never post formal GitHub reviews, edit code, or merge.\n`,
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

// ─── Exports ────────────────────────────────────────────────────────
export {
  // Bootstrap
  initProjects,
  migrateAhwDirectories,
  migrateWebhookRepoToProject,
  migrateWorkflowProjectWorkspaces,
  migrateAgentMcpServers,
  migrateStaleMcpConfigFiles,
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
  migrateProjectSkillDirectories,
  // Auto-create helpers
  ensureDocsAgents,
  retireIntakeAgents,
  ensureSkillBuilderAgents,
  ensureReviewerAgents,
  ensureContextFiles,
};
