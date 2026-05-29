/**
 * Finalize Code Changes — `.agent-hub/ci.yaml` setup wizard.
 *
 * Mirrors the preview-setup-wizard pattern: spawn a one-shot session
 * with the server-precomputed draft baked into the kickoff prompt, let
 * the user iterate via `agenthub:ask`, then commit the final YAML to
 * the worktree in one shot.
 *
 *   POST /api/projects/:projectId/finalize/setup-wizard
 *     Admin+. Spawns a wizard session loaded with the `finalize-setup`
 *     skill, embedding the project draft. Returns
 *     `{ sessionId, agentId, draft, session }`.
 *
 *   POST /api/projects/:projectId/finalize/setup-apply
 *     Admin+. Validates the proposed `ci_yaml_content` against the v1
 *     schema (server/finalize/ci-config.ts), writes it to
 *     `<worktree>/.agent-hub/ci.yaml`, and commits it to the worktree's
 *     branch. Returns `{ ok, file, commit_sha, branch }`.
 *
 *   POST /api/projects/:projectId/finalize/wizard-complete
 *     User+. Broadcasts `finalize_wizard_complete` for the Settings
 *     panel so it can refresh state.
 *
 * Lookup order for the target worktree (apply endpoint):
 *   - Request body `session_id` (when the chat session knows its own id)
 *   - The wizard's own session id (when the apply call originates from
 *     the wizard's `[Finalize Setup]` session, which itself has no
 *     worktree). We fall back to the most-recent session for the project
 *     that has both a `worktree_path` and a `worktree_branch`.
 *
 * Tests live in `server/routes/finalize-wizard.test.ts`.
 */
import path from 'path';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireRole } from '../roles.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { collectFinalizeSetupDraft, type FinalizeSetupDraft } from '../finalize-setup-draft.js';
import { parseCiConfig } from '../finalize/ci-config.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { Project, RouteDeps, SessionRow } from '../types.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FINALIZE_SETUP_SKILL_SCRIPTS_DIR = path.resolve(
  __dirname,
  '..',
  'default-skills',
  'finalize-setup',
  'scripts',
);

export const FINALIZE_CI_CONFIG_RELATIVE_PATH = '.agent-hub/ci.yaml';

const SESSION_NAME_PREFIX = '[Finalize Setup]';
const COMMIT_MESSAGE_TITLE = 'Add .agent-hub/ci.yaml via Finalize setup wizard';
const COMMIT_AUTHOR_NAME = 'agent-hub-bot';
const COMMIT_AUTHOR_EMAIL = 'agent-hub-bot@local';

const GIT_TIMEOUT_MS = 30_000;

export function isFinalizeSetupWizardSession(session: { name?: string | null }): boolean {
  return typeof session.name === 'string' && session.name.startsWith(SESSION_NAME_PREFIX);
}

function pickWizardAgent(project: Project): string | null {
  if (!project.agents || !Array.isArray(project.agents) || project.agents.length === 0) {
    return null;
  }
  return project.agents[0].id;
}

interface ApplyBody {
  ci_yaml_content?: string;
  /**
   * Optional explicit session id whose worktree should receive the file.
   * Falls through to the "most recent session for this project with a
   * worktree" heuristic when missing — the wizard session itself does
   * not have a worktree, so the originating session id is the canonical
   * pointer.
   */
  session_id?: string;
}

interface SessionWithWorktree {
  id: string;
  worktree_path: string;
  worktree_branch: string;
}

function pickSessionWithWorktree(
  stmts: RouteDeps['stmts'],
  project: Project,
  preferredSessionId: string | undefined,
): SessionWithWorktree | null {
  if (preferredSessionId) {
    const row = stmts.getSession.get(preferredSessionId) as SessionRow | undefined;
    if (row && row.worktree_path && row.worktree_branch) {
      return {
        id: row.id,
        worktree_path: row.worktree_path,
        worktree_branch: row.worktree_branch,
      };
    }
  }
  // Walk the project's agents and look for the most-recent session with a
  // worktree. `getSessions` is `SELECT * FROM sessions WHERE agent_id = ?
  // … ORDER BY updated_at DESC`, so the first hit per agent is the
  // freshest one. We pick the freshest hit across all agents.
  // updated_at is an ISO string; lexical comparison matches chronological.
  let best: { row: SessionRow; updated: string } | null = null;
  for (const agent of project.agents ?? []) {
    const rows = stmts.getSessions.all(agent.id) as SessionRow[];
    for (const row of rows) {
      if (!row.worktree_path || !row.worktree_branch) continue;
      const updated = row.updated_at ?? '';
      if (!best || updated > best.updated) {
        best = { row, updated };
      }
      break; // rows are pre-sorted DESC; first hit per agent is freshest
    }
  }
  if (!best) return null;
  return {
    id: best.row.id,
    worktree_path: best.row.worktree_path as string,
    worktree_branch: best.row.worktree_branch as string,
  };
}

export function buildKickoffPrompt(
  projectId: string,
  projectCwd: string,
  draft: FinalizeSetupDraft,
  worktreePath: string | null,
): string {
  const draftJson = JSON.stringify(draft, null, 2);
  return [
    '# Finalize Setup — guided walkthrough (required)',
    '',
    'You are the **default** authoring path for `.agent-hub/ci.yaml`. Walk the user through Finalize configuration **interactively** — do not tell them to read schema docs. The repo scan below is the starting point.',
    '',
    '## Bound values',
    '',
    `- **PROJECT_ID**: \`${projectId}\``,
    `- **PROJECT_CWD**: \`${projectCwd}\``,
    `- **WORKTREE_PATH**: \`${worktreePath ?? '(unknown — apply will fail until a session with a worktree exists)'}\``,
    '',
    '## Server-provided draft (do NOT re-run scanners)',
    '',
    '```json',
    draftJson,
    '```',
    '',
    'Key fields: `stack`, `packageManager`, `isMonorepo`, `subprojects[]`, `existingCi` + `existingCiContent`, `npmScripts`, `makefileTargets`, `githubWorkflows`, `envVars`, **`proposedCiYaml`** (pre-built, parses cleanly).',
    '',
    '## Required walkthrough order',
    '',
    '1. **Summarise the repo** — read `README.md` if useful, then state primary stack + package manager + what CI already runs (from `draft.githubWorkflows`).',
    '2. **Existing config** — when `draft.existingCi === true`, show `draft.existingCiContent` and ask whether to overwrite, edit in place, or abort. Do not silently overwrite.',
    '3. **Monorepo / sub-projects** — when `draft.isMonorepo`, list every entry in `draft.subprojects[]` and ask whether to run all or pick one.',
    '4. **Step proposal** — show `draft.proposedCiYaml` verbatim in a fenced ```yaml block. Ask: use as-is, edit steps, or add a custom step. Respect the v1 schema constraints: `version: 1`, `on:` of `finalize`/`manual`, `name`+`run` per step only, `timeout_minutes` in `[1, 60]`.',
    '5. **Env vars** — call out `draft.envVars` entries the steps will read. v1 has no `env:` field; point at Settings → Secrets if values need to be injected at run time.',
    '6. **Persist** — `POST .../finalize/setup-apply` with `{ "ci_yaml_content": "<the final YAML>" }`. Server validates against the v1 parser; on 400 with `ci_config_invalid`, fix the error code/path and retry.',
    '7. **`POST .../finalize/wizard-complete`**, then `<agenthub:close-card>`.',
    '',
    '**Ask JSON must use `question` + `header` + `options[].label` + `options[].description`** — not `prompt`, `id`, or `type`.',
    '',
    '**Never** propose `shell:`, `env:`, `uses:`, `with:`, or `matrix:` on a step — the v1 parser rejects them.',
    '',
    '<agenthub:skill>',
    JSON.stringify({
      name: 'finalize-setup',
      reason: 'guided ci.yaml setup — draft + cheat sheet bundled',
    }),
    '</agenthub:skill>',
  ].join('\n');
}

export default function createFinalizeWizardRoutes(deps: RouteDeps): Router {
  const { findProject, findAgent, stmts, handleChat, broadcast, config } = deps;
  const router = Router();

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/finalize/setup-wizard
  // ───────────────────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/finalize/setup-wizard',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const cwd = project.cwd;
      if (!cwd || typeof cwd !== 'string') {
        res.status(400).json({ error: 'Project has no cwd configured' });
        return;
      }
      const agentId = pickWizardAgent(project);
      if (!agentId) {
        res.status(400).json({ error: 'Project has no agents to host the wizard session' });
        return;
      }
      const agentLookup = findAgent(agentId);
      if (!agentLookup) {
        res.status(500).json({ error: 'Wizard agent could not be resolved' });
        return;
      }

      // Use the project root for the scan. The worktree (target of
      // setup-apply) is decided at apply time — the wizard does NOT need
      // a worktree to introspect; the proposed YAML is identical
      // regardless of which branch ends up receiving the commit.
      const draft = collectFinalizeSetupDraft(cwd);
      const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const sessionId = uuidv4();
      const engine = agentLookup.agent.engine || 'claude-code';
      const model = resolveEffectiveModel(config, engine, {
        agentModel: agentLookup.agent.model,
        ownerUserId: ownerUid,
      });
      const sessionName = `${SESSION_NAME_PREFIX} ${project.name || project.id}`;
      const useWorktree = 0;
      const askMode = 0;
      stmts.createSession.run(
        sessionId,
        agentId,
        sessionName,
        engine,
        model,
        useWorktree,
        askMode,
        1,
      );
      setSessionOwner(sessionId, ownerUid);

      // Pick a worktree to display in the kickoff prompt (informational
      // only — apply re-resolves at request time).
      const preferred = pickSessionWithWorktree(stmts, project, undefined);
      const prompt = buildKickoffPrompt(project.id, cwd, draft, preferred?.worktree_path ?? null);
      void handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: prompt,
      });

      const session = stmts.getSession.get(sessionId) as SessionRow;
      broadcast({
        type: 'finalize_wizard_started',
        projectId: project.id,
        sessionId,
        agentId,
      });
      res.status(201).json({ sessionId, agentId, draft, session });
    },
  );

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/finalize/setup-apply
  // ───────────────────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/finalize/setup-apply',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const body = (req.body ?? {}) as ApplyBody;
      const content = typeof body.ci_yaml_content === 'string' ? body.ci_yaml_content : '';
      if (!content.trim()) {
        res.status(400).json({ error: 'ci_yaml_content must be a non-empty string' });
        return;
      }
      // v1 validation upstream of the disk write — a malformed file
      // never lands on the branch.
      const parsed = parseCiConfig(content);
      if (!parsed.ok) {
        res.status(400).json({
          error: 'ci_config_invalid',
          code: parsed.error.code,
          message: parsed.error.message,
          path: parsed.error.path ?? null,
        });
        return;
      }
      const target = pickSessionWithWorktree(stmts, project, body.session_id);
      if (!target) {
        res.status(400).json({
          error: 'no_worktree',
          message:
            'No session with an active worktree was found for this project. Start a card-linked session first; the wizard commits to that session’s worktree.',
        });
        return;
      }

      // Defensive: ensure the worktree path is inside the configured
      // workspaces root or the project cwd. We don't enforce a hard
      // policy here (the worktree column is server-managed), but a
      // missing directory is a real error we should surface.
      try {
        const stat = await fs.stat(target.worktree_path);
        if (!stat.isDirectory()) {
          res.status(400).json({ error: 'worktree_path is not a directory' });
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({
          error: 'worktree_missing',
          message: `Worktree path is unreadable: ${message}`,
        });
        return;
      }

      const absFile = path.join(target.worktree_path, FINALIZE_CI_CONFIG_RELATIVE_PATH);
      try {
        await fs.mkdir(path.dirname(absFile), { recursive: true });
        const toWrite = content.endsWith('\n') ? content : `${content}\n`;
        await fs.writeFile(absFile, toWrite, 'utf8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'write_failed', message });
        return;
      }

      // Stage + commit in the worktree. We scope `git add` to the file
      // we just wrote so unrelated worktree edits never sneak into the
      // commit. Author identity is a local fallback — push-time signing
      // is unchanged.
      const commitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
        GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL,
      };
      try {
        await execFileAsync('git', ['add', '--', FINALIZE_CI_CONFIG_RELATIVE_PATH], {
          cwd: target.worktree_path,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 1 * 1024 * 1024,
          env: commitEnv,
        });
        await execFileAsync('git', ['commit', '--allow-empty', '-m', COMMIT_MESSAGE_TITLE], {
          cwd: target.worktree_path,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 1 * 1024 * 1024,
          env: commitEnv,
        });
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: target.worktree_path,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 1 * 1024 * 1024,
          env: commitEnv,
        });
        const commitSha = stdout.trim();
        res.json({
          ok: true,
          file: FINALIZE_CI_CONFIG_RELATIVE_PATH,
          commit_sha: commitSha,
          branch: target.worktree_branch,
          session_id: target.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'commit_failed', message });
      }
    },
  );

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/finalize/wizard-complete
  // ───────────────────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/finalize/wizard-complete',
    requireRole('User'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (project) {
        broadcast({
          type: 'finalize_wizard_complete',
          projectId: project.id,
        });
      }
      res.json({ ok: true });
    },
  );

  return router;
}
