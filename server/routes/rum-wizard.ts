/**
 * AI RUM (real user monitoring) instrumentation wizard routes.
 *
 *   GET /api/projects/:projectId/rum/setup-draft
 *     Admin+. Scans the project's working copy for the signal the
 *     recorder-injection wizard needs before touching code: frontend
 *     framework, injection-target candidates, existing CSP locations, and
 *     whether the rrweb recorder is already wired. Returns
 *     `{ projectId, draft }` — read-only, no session spawn, no file
 *     writes.
 *
 *   POST /api/projects/:projectId/rum/setup-wizard
 *     Admin+. Spawns a worktree-backed `[RUM Setup]` chat session
 *     (`use_worktree=1`) loaded with the `rum-setup` skill, with the
 *     server-precomputed detection draft embedded in the kickoff prompt.
 *     The agent injects the rrweb recorder init into
 *     `draft.plan.targetFile` using `draft.plan.injectionStyle`, extends
 *     any `draft.cspHits` with the ingest connect-src origin, then calls
 *     `setup-apply` to commit. Finalize Code Changes pushes + opens the PR.
 *     Returns `{ sessionId, agentId, draft, session }`.
 *
 *   POST /api/projects/:projectId/rum/setup-apply
 *     Admin+. Stages and commits the instrumentation files the wizard
 *     edited (recorder target, any new client component, each CSP file)
 *     into the session's own worktree branch, then lets the existing
 *     Finalize Code Changes / pulls flow push and open the PR. Mirrors
 *     `finalize/setup-apply`, but commits a caller-supplied `files[]` list
 *     (validated to stay inside the worktree) with `git commit -o` so
 *     unrelated pre-staged work is left untouched. Returns
 *     `{ ok, files, commit_sha, branch, session_id }`.
 *
 * This is the recorder-injection slice of the broader "Hub as RUM vendor"
 * wizard. The per-project client token is tracked as a separate follow-up
 * slice.
 */
import path from 'path';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireRole } from '../roles.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { collectRumSetupDraft, type RumSetupDraft } from '../rum-setup-draft.js';
import {
  resolveApplyTarget,
  createAndProvisionCommitTarget,
} from '../finalize/finalize-setup-apply-target.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps, Project, SessionRow } from '../types.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const RUM_COMMIT_MESSAGE_TITLE = 'Instrument rrweb recorder via RUM setup wizard';
const COMMIT_AUTHOR_NAME = 'agent-hub-bot';
const COMMIT_AUTHOR_EMAIL = 'agent-hub-bot@local';

interface RumApplyBody {
  /**
   * Relative paths (inside the worktree) of the instrumentation files the
   * wizard edited or created. Only these paths are staged + committed.
   */
  files?: unknown;
  /** Optional session id whose worktree receives the commit. */
  session_id?: string;
  /** Optional commit message override. */
  message?: string;
}

export type ValidatedInstrumentationFiles =
  | { ok: true; files: string[] }
  | { ok: false; error: string };

/**
 * Shape-only validation of a caller-supplied instrumentation file list —
 * **no worktree needed**, so it can run before the endpoint resolves or
 * auto-provisions a target session/worktree. Rejects non-arrays, empty
 * lists, non-string / blank entries, absolute paths, and any path whose
 * own segments escape upward (`..`). Returns the trimmed entries (not yet
 * resolved against a worktree root).
 *
 * Splitting the worktree-free checks out keeps a malformed request like
 * `{ files: [] }` from creating a throwaway `[RUM Config]` session/branch
 * before failing.
 */
export function validateInstrumentationFilesShape(raw: unknown): ValidatedInstrumentationFiles {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'files must be a non-empty array of relative paths' };
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      return { ok: false, error: 'each file must be a non-empty string' };
    }
    const rel = entry.trim();
    if (path.isAbsolute(rel)) {
      return { ok: false, error: `file must be a relative path, got absolute: ${rel}` };
    }
    // Worktree-independent escape check: normalize collapses any `..`
    // segments; if the result still climbs above the (implicit) root it
    // starts with `..`.
    const normalized = path.normalize(rel);
    if (normalized === '..' || normalized.startsWith('..' + path.sep)) {
      return { ok: false, error: `file escapes the worktree: ${rel}` };
    }
    out.push(rel);
  }
  return { ok: true, files: out };
}

/**
 * Resolve shape-validated relative paths against a concrete worktree root,
 * deduplicating and re-checking (defense in depth) that nothing escapes
 * the root. Returns normalized, de-duplicated relative paths (relative to
 * the worktree). Call {@link validateInstrumentationFilesShape} first.
 */
export function resolveInstrumentationFiles(
  files: string[],
  worktreePath: string,
): ValidatedInstrumentationFiles {
  const root = path.resolve(worktreePath);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rel of files) {
    const abs = path.resolve(root, rel);
    const normalizedRel = path.relative(root, abs);
    if (!normalizedRel || normalizedRel === '..' || normalizedRel.startsWith('..' + path.sep)) {
      return { ok: false, error: `file escapes the worktree: ${rel}` };
    }
    if (!seen.has(normalizedRel)) {
      seen.add(normalizedRel);
      out.push(normalizedRel);
    }
  }
  return { ok: true, files: out };
}

/** Derive a bare origin from a configured public URL, if parseable. */
function ingestOriginFromConfig(publicUrl: unknown): string | undefined {
  if (typeof publicUrl !== 'string' || !publicUrl.trim()) return undefined;
  try {
    return new URL(publicUrl).origin;
  } catch {
    return undefined;
  }
}

function pickWizardAgent(project: Project): string | null {
  if (!project.agents || !Array.isArray(project.agents) || project.agents.length === 0) {
    return null;
  }
  return project.agents[0].id;
}

export function isRumSetupWizardSession(session: { name?: string | null }): boolean {
  return typeof session.name === 'string' && session.name.startsWith('[RUM Setup]');
}

export function buildRumKickoffPrompt(
  projectId: string,
  projectCwd: string,
  draft: RumSetupDraft,
  sessionId: string,
  maskAllText: boolean = false,
): string {
  const draftJson = JSON.stringify(draft, null, 2);
  const target = draft.plan.targetFile ?? '(none detected — pick from entryCandidates)';
  const style = draft.plan.injectionStyle ?? '(undetermined)';
  const cspCount = draft.cspHits.length;
  const webRootLabel = draft.webRoot && draft.webRoot !== '.' ? draft.webRoot : 'repo root';
  const maskingPolicy = maskAllText
    ? 'mask ALL text and inputs — only structure, layout, navigation and interaction timing are recorded (strictest)'
    : 'mask password and PII fields only — other input values and visible text are recorded verbatim';
  return [
    '# RUM Setup — recorder injection (required)',
    '',
    'You are a **worktree-backed** setup session: you already sit on a fresh',
    '`agent-hub/…` branch. Inject the rrweb recorder, commit, and let Finalize',
    'Code Changes push and open the PR. **Do not** create a new branch.',
    '',
    'This repo scan detected web app root **' +
      webRootLabel +
      '**, framework **' +
      draft.framework +
      '**, target file **' +
      target +
      '**, injection style **' +
      style +
      '**, and **' +
      String(cspCount) +
      '** existing CSP location(s) to extend.',
    '',
    '## Bound values',
    '',
    `- **PROJECT_ID**: \`${projectId}\``,
    `- **PROJECT_CWD**: \`${projectCwd}\``,
    `- **YOUR SESSION_ID**: \`${sessionId}\``,
    `- **Recorder masking policy**: \`maskAllText = ${String(maskAllText)}\` — ${maskingPolicy}. Bake this into the recorder init so it is applied at capture time.`,
    '- **`$AGENT_HUB_URL`**, **`$AGENT_HUB_API_KEY`**: use these for any wizard API call. If a call returns HTTP 401 or 403, halt and report the auth failure. Never ask the operator to paste a token into chat.',
    '',
    '## Server-provided draft (repo scan — do not re-run scanners)',
    '',
    '```json',
    draftJson,
    '```',
    '',
    'Key fields: `webRoot`, `framework`, `plan.targetFile`, `plan.injectionStyle` (`module-init` | `client-component` | `script-tag`), `plan.recommendedConnectSrc` (ingest origin for `connect-src`), `plan.alreadyInstrumented`, `cspHits[]`, `entryCandidates[]`, `typescript`.',
    '',
    '## Required walkthrough order',
    '',
    '1. **Confirm the target** — Summarize framework, `plan.targetFile`, and `plan.injectionStyle`. If `plan.alreadyInstrumented` is true or `plan.targetFile` is null, use a fenced `agenthub:ask` (offer `entryCandidates` as options) before editing.',
    "2. **Inject the recorder** — Edit `plan.targetFile` per `plan.injectionStyle`. For `client-component` (Next app-router Server Component layouts), create a `'use client'` child that starts the recorder in `useEffect` — never inline into the server layout. POST replays to `plan.recommendedConnectSrc` + `/api/replays`. Initialise the recorder with `maskAllInputs: " +
      String(maskAllText) +
      '` and `maskAllText: ' +
      String(maskAllText) +
      '` (both follow the masking policy above; password and PII fields are always masked regardless). See the rum-setup skill for the exact option placement.',
    '3. **Extend the CSP** — For every `cspHits` entry, add `plan.recommendedConnectSrc` to its `connect-src` directive (derive from `default-src` if absent). If `cspHits` is empty, note no CSP was found.',
    '4. **Verify + apply** — Type-check/build the target if a script exists, then commit your instrumentation by calling `POST $AGENT_HUB_URL/api/projects/' +
      projectId +
      '/rum/setup-apply` with `{ "session_id": "' +
      sessionId +
      '", "files": ["<every file you edited or created>"] }` — list the recorder target, any new client component, and each CSP file. This stages and commits ONLY those paths on THIS session branch (`git commit -o`), leaving unrelated staged work intact. Send `-H "X-API-Key: $AGENT_HUB_API_KEY"`. On HTTP 400 fix the reported error (`invalid_files`, `file_missing`, `nothing_to_commit`) and retry. Then `<agenthub:close-card>` — Finalize Code Changes pushes and opens the PR.',
    '',
    '**Ask JSON must use `question` + `header` + `options[].label` + `options[].description`** — not `prompt`, `id`, or `type`.',
    '',
    '<agenthub:skill>',
    JSON.stringify({
      name: 'rum-setup',
      reason: 'framework-specific recorder injection — draft embedded above',
    }),
    '</agenthub:skill>',
  ].join('\n');
}

export default function createRumWizardRoutes(deps: RouteDeps): Router {
  const { findProject, findAgent, stmts, handleChat, broadcast, config } = deps;
  const router = Router();

  router.get(
    '/api/projects/:projectId/rum/setup-draft',
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
      const draft = collectRumSetupDraft(cwd, {
        ingestOrigin: ingestOriginFromConfig(config?.publicUrl),
      });
      res.json({ projectId: project.id, draft });
    },
  );

  router.post(
    '/api/projects/:projectId/rum/setup-wizard',
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

      // Masking policy for the injected recorder, chosen per target app at
      // setup time. Defaults to false = "passwords & PII only" (record other
      // input values and visible text verbatim) — the sensible default for
      // instrumenting third-party apps. The wizard always passes this through
      // as an explicit recorder option (`maskOptionsForMode`), so the injected
      // recorder never inherits the engine's fail-closed `DEFAULT_MASK_OPTIONS`
      // baseline (which masks all inputs). The strict `true` (mask everything)
      // is opt-in.
      const maskAllText = (req.body as { maskAllText?: unknown })?.maskAllText === true;

      const draft = collectRumSetupDraft(cwd, {
        ingestOrigin: ingestOriginFromConfig(config?.publicUrl),
      });
      const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const sessionId = uuidv4();
      const engine = agentLookup.agent.engine || 'claude-code';
      const model = resolveEffectiveModel(config, engine, {
        agentModel: agentLookup.agent.model,
        ownerUserId: ownerUid,
        agentId,
      });
      const sessionName = `[RUM Setup] ${project.name || project.id}`;
      // use_worktree=1: the wizard authors the recorder init and CSP edits
      // on its own branch, then uses Finalize Code Changes for review/push
      // like any normal coding session (mirrors preview/finalize setup).
      const useWorktree = 1;
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

      const prompt = buildRumKickoffPrompt(project.id, cwd, draft, sessionId, maskAllText);
      // Fire-and-forget chat handler — the HTTP response is already in
      // flight. The worktree is provisioned inside handleChat
      // (ensureWorktree) before the agent's first turn runs.
      void handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: prompt,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[rum-wizard] handleChat failed for session ${sessionId}: ${message}`);
      });

      const session = stmts.getSession.get(sessionId) as SessionRow;
      broadcast({
        type: 'rum_wizard_started',
        projectId: project.id,
        sessionId,
        agentId,
      });
      res.status(201).json({ sessionId, agentId, draft, session });
    },
  );

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/rum/setup-apply
  // ───────────────────────────────────────────────────────────────
  //
  // Commit the instrumentation edits the wizard made (recorder target,
  // any new client component, each CSP file) into the session's own
  // worktree branch so the existing Finalize Code Changes / pulls flow can
  // push and open the PR. Mirrors finalize/setup-apply but commits a
  // caller-supplied `files[]` list rather than a single fixed file.
  router.post(
    '/api/projects/:projectId/rum/setup-apply',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const body = (req.body ?? {}) as RumApplyBody;

      // Shape-only validation FIRST — before resolving or auto-provisioning
      // a worktree. A malformed `files` payload must not leave persistent
      // side effects (a throwaway `[RUM Config]` session/branch).
      const shape = validateInstrumentationFilesShape(body.files);
      if (!shape.ok) {
        res.status(400).json({ error: 'invalid_files', message: shape.error });
        return;
      }

      // Resolve the target worktree (session_id when supplied, else the
      // most-recent worktree-bearing session). Same lookup order as
      // finalize/setup-apply.
      let target = await resolveApplyTarget(
        { stmts, provisionSessionWorkspace: deps.provisionSessionWorkspace },
        project,
        body.session_id,
      );
      // No existing worktree-bearing session: provision a dedicated
      // `[RUM Config]` worktree so the instrumentation has somewhere to
      // land (mirrors the finalize fallback).
      if (!target) {
        const agentId = pickWizardAgent(project);
        const agentLookup = agentId ? findAgent(agentId) : null;
        if (agentId && agentLookup) {
          const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
          const engine = agentLookup.agent.engine || 'claude-code';
          const model = resolveEffectiveModel(config, engine, {
            agentModel: agentLookup.agent.model,
            ownerUserId: ownerUid,
            agentId,
          });
          target = await createAndProvisionCommitTarget(
            { stmts, provisionSessionWorkspace: deps.provisionSessionWorkspace },
            {
              agentId,
              name: `[RUM Config] ${project.name || project.id}`,
              engine,
              model,
            },
            (sid) => setSessionOwner(sid, ownerUid),
          );
        }
      }
      if (!target) {
        res.status(400).json({
          error: 'no_worktree',
          message:
            'No session with an active worktree was found and a dedicated config worktree could not be provisioned (is the project cwd a git repo?). Pass `session_id` for the wizard session you are working in.',
        });
        return;
      }

      // Resolve the (shape-valid) paths against the concrete worktree
      // root: deduplicate + re-check escape now that we have a root.
      const validated = resolveInstrumentationFiles(shape.files, target.worktree_path);
      if (!validated.ok) {
        res.status(400).json({ error: 'invalid_files', message: validated.error });
        return;
      }

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

      // Every listed path must already exist in the worktree AND be a
      // regular file — the wizard is committing edits it already made, not
      // authoring new content here. Rejecting directories is essential:
      // `git add -- <dir>` / `git commit -o -- <dir>` would sweep in every
      // changed file under that directory, breaking the "only the listed
      // files are committed" contract. `fs.stat` follows symlinks, so a
      // symlink to a regular file is accepted.
      for (const rel of validated.files) {
        let st;
        try {
          st = await fs.stat(path.join(target.worktree_path, rel));
        } catch {
          res.status(400).json({
            error: 'file_missing',
            message: `Instrumentation file not found in worktree: ${rel}`,
          });
          return;
        }
        if (!st.isFile()) {
          res.status(400).json({
            error: 'not_a_file',
            message: `Instrumentation path is not a regular file (directories are not allowed): ${rel}`,
          });
          return;
        }
      }

      const message =
        typeof body.message === 'string' && body.message.trim()
          ? body.message.trim()
          : RUM_COMMIT_MESSAGE_TITLE;

      // Author identity is a local fallback — push-time signing is
      // unchanged. `git commit -o` commits ONLY the listed paths so any
      // unrelated pre-staged work on the session index stays staged.
      const commitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
        GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL,
      };
      const gitOpts = {
        cwd: target.worktree_path,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1 * 1024 * 1024,
        env: commitEnv,
      };
      try {
        await execFileAsync('git', ['add', '--', ...validated.files], gitOpts);
        // Refuse an empty commit: if none of the listed files have changes,
        // the instrumentation never landed — surface that instead of
        // committing nothing.
        const { stdout: statusOut } = await execFileAsync(
          'git',
          ['status', '--porcelain', '--', ...validated.files],
          gitOpts,
        );
        if (!statusOut.trim()) {
          res.status(400).json({
            error: 'nothing_to_commit',
            message: 'None of the listed instrumentation files have changes to commit.',
          });
          return;
        }
        await execFileAsync(
          'git',
          ['commit', '-o', '-m', message, '--', ...validated.files],
          gitOpts,
        );
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], gitOpts);
        const commitSha = stdout.trim();
        res.json({
          ok: true,
          files: validated.files,
          commit_sha: commitSha,
          branch: target.worktree_branch,
          session_id: target.id,
        });
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'commit_failed', message: errMessage });
      }
    },
  );

  return router;
}
