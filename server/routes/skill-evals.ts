import { Router, Request, Response } from 'express';
import path from 'path';
import os from 'os';
import {
  existsSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { z } from 'zod';
import type { RouteDeps } from '../types.js';
import type { SupportedEngine } from '../engine-availability.js';
import { requireRole } from '../roles.js';
import { validateSkillSlug } from '../skill-write.js';
import { parseEvals, serializeEvals, type SkillEval } from '../skill-evals.js';
import { runSkillEvals, type OneShotRunner } from '../skill-eval-runner.js';
import { loadSkillBody, buildSkillInjection } from '../skill-invoke.js';
import { resolveOneShotEngine, NoEnginesAvailableError } from '../engine-resolver.js';
import { runOneShotPrompt } from '../one-shot-spawn.js';
import { buildSpawnEnv } from '../config.js';
import { resolveProjectSkillsDir } from '../project-model.js';

/**
 * Skill Builder, Phase 3 — eval-driven test loop REST surface.
 *
 *   GET    /api/projects/:projectId/skills/:skillId/evals       read evals.json
 *   PUT    /api/projects/:projectId/skills/:skillId/evals       write evals.json
 *   POST   /api/projects/:projectId/skills/:skillId/evals/run   run with-skill vs baseline
 *
 * Evals live beside the project-authored skill under the central project skill
 * store. The run
 * endpoint loads the skill's SKILL.md, injects it as the system prompt for the
 * with-skill pass, runs an identical baseline pass without it, grades both, and
 * returns a structured summary plus a rendered Markdown report. The Skill
 * Builder coach calls these via `ah-api.sh` to iterate on a draft skill.
 *
 * Gemini is excluded from the engine fallback chain (reserved for RAG/
 * embeddings) — same rule as project analyze.
 */

// Agent CLIs only — Gemini is reserved for RAG/embeddings, never interactive.
// This is both the resolver fallback chain AND the set of engines a caller may
// request via `engine`, so a typo / `gemini-cli` request 400s rather than
// silently running a different (or broader) engine than asked for.
const EVAL_ENGINES = ['claude-code', 'cursor-agent', 'codex-cli'] as const;
const EVAL_FALLBACK_CHAIN: readonly SupportedEngine[] = EVAL_ENGINES;
const DEFAULT_EVAL_TIMEOUT_MS = 3 * 60 * 1000;
const MIN_EVAL_TIMEOUT_MS = 1000;
const MAX_EVAL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The `POST .../evals/run` body. Validated at the route boundary so a client
 * typo can't silently reinterpret expensive options — this endpoint spawns
 * external agent processes per eval, so `evalIds: "happy"` (a string, not an
 * array) must 400, not fall through to "run the whole suite", and a bad
 * `engine`/`timeoutMs` must 400, not coerce. `.strict()` also rejects unknown
 * keys so a misspelled field (`evalId`, `timeout`) surfaces instead of being
 * dropped. Deep validation of the inline `evals` array stays with `parseEvals`
 * (richer per-field messages); here it only has to be an array.
 */
const RunBodySchema = z
  .object({
    evals: z.array(z.unknown()).optional(),
    // `.min(1)`: an explicitly empty `evalIds` is a 400, not "no filter". An
    // empty selected set from a client/UI bug must not silently expand to
    // running (and spawning) the entire suite — the opposite of what the caller
    // asked for. Omit the field to run everything.
    evalIds: z.array(z.string()).min(1).optional(),
    engine: z.enum(EVAL_ENGINES).optional(),
    model: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().min(MIN_EVAL_TIMEOUT_MS).max(MAX_EVAL_TIMEOUT_MS).optional(),
  })
  .strict();

function evalsFilePath(skillsDir: string, skillId: string): string {
  return path.join(skillsDir, skillId, 'evals', 'evals.json');
}

function skillDirExists(skillsDir: string, skillId: string): boolean {
  const dir = path.join(skillsDir, skillId);
  return existsSync(dir) && statSync(dir).isDirectory();
}

export default function createSkillEvalRoutes(deps: RouteDeps): Router {
  const { findProject, config } = deps;
  const router = Router();

  // Read the eval suite for a project skill. Missing file => empty list.
  router.get('/api/projects/:projectId/skills/:skillId/evals', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.ahw) return res.status(400).json({ error: 'No workspace configured for project' });

    const slugRes = validateSkillSlug(req.params.skillId, 'skillId');
    if ('error' in slugRes) return res.status(400).json({ error: slugRes.error });
    const skillId = slugRes.slug;
    const skillsDir = resolveProjectSkillsDir(project);

    if (!skillDirExists(skillsDir, skillId)) {
      return res.status(404).json({ error: 'Project skill not found' });
    }

    const file = evalsFilePath(skillsDir, skillId);
    if (!existsSync(file)) return res.json({ evals: [] });

    try {
      const parsed = parseEvals(JSON.parse(readFileSync(file, 'utf-8')));
      if (!parsed.ok) {
        return res.status(422).json({ error: `evals.json is invalid: ${parsed.error}` });
      }
      return res.json({ evals: parsed.evals });
    } catch (err) {
      return res
        .status(422)
        .json({ error: `could not parse evals.json: ${(err as Error).message}` });
    }
  });

  // Write the eval suite for a project skill. Mutates project workspace state,
  // so it requires the Admin project-mutation role (same boundary as other
  // project-scoped write routes) — visibility alone only gates reads.
  router.put(
    '/api/projects/:projectId/skills/:skillId/evals',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!project.ahw)
        return res.status(400).json({ error: 'No workspace configured for project' });

      const slugRes = validateSkillSlug(req.params.skillId, 'skillId');
      if ('error' in slugRes) return res.status(400).json({ error: slugRes.error });
      const skillId = slugRes.slug;
      const skillsDir = resolveProjectSkillsDir(project);

      if (!skillDirExists(skillsDir, skillId)) {
        return res.status(404).json({ error: 'Project skill not found' });
      }

      const parsed = parseEvals(req.body ?? {});
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      try {
        const dir = path.join(skillsDir, skillId, 'evals');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'evals.json'), serializeEvals(parsed.evals));
        return res.json({ evals: parsed.evals });
      } catch (err) {
        return res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // Run the eval suite: with-skill vs baseline, grade, return a report.
  // Spawns external agent CLIs (with bypassed permissions) from user-authored
  // prompts and consumes configured agent credentials, so it requires the same
  // Admin project-mutation/agent-spawn role as other spawn endpoints — not just
  // project visibility.
  router.post(
    '/api/projects/:projectId/skills/:skillId/evals/run',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!project.ahw) {
        return res.status(400).json({ error: 'No workspace configured for project' });
      }

      const slugRes = validateSkillSlug(req.params.skillId, 'skillId');
      if ('error' in slugRes) return res.status(400).json({ error: slugRes.error });
      const skillId = slugRes.slug;

      const skillsDir = resolveProjectSkillsDir(project);
      if (!skillDirExists(skillsDir, skillId)) {
        return res.status(404).json({ error: 'Project skill not found' });
      }

      // Validate the whole options envelope before doing any (expensive) work.
      const bodyResult = RunBodySchema.safeParse(req.body ?? {});
      if (!bodyResult.success) {
        const first = bodyResult.error.issues[0];
        return res.status(400).json({
          error: first?.message ?? 'Invalid request body',
          details: bodyResult.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
      const body = bodyResult.data;

      // Source of evals: inline `evals` in the body (lets the coach iterate on
      // the eval suite without PUTting it first — the skill's SKILL.md is still
      // loaded from disk below, so the skill itself must already be saved) or
      // the saved evals.json on disk.
      let evals: SkillEval[];
      if (body.evals !== undefined) {
        const parsed = parseEvals(body.evals);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        evals = parsed.evals;
      } else {
        const file = evalsFilePath(skillsDir, skillId);
        if (!existsSync(file)) {
          return res
            .status(400)
            .json({ error: 'no evals defined for this skill — PUT an evals suite first' });
        }
        try {
          const parsed = parseEvals(JSON.parse(readFileSync(file, 'utf-8')));
          if (!parsed.ok)
            return res.status(422).json({ error: `evals.json is invalid: ${parsed.error}` });
          evals = parsed.evals;
        } catch (err) {
          return res
            .status(422)
            .json({ error: `could not parse evals.json: ${(err as Error).message}` });
        }
      }

      // Optionally narrow to a subset of eval ids (single-prompt re-run). When
      // present `evalIds` is non-empty (schema-enforced — an empty set 400s
      // rather than running everything). Every requested id must exist: a
      // partial miss (e.g. ["happy", "typo"]) is a 400 listing the missing ids,
      // not a silent run of the resolvable subset — otherwise the caller thinks
      // the full requested set was evaluated.
      if (body.evalIds) {
        const available = new Set(evals.map((e) => e.id));
        const missing = [...new Set(body.evalIds)].filter((id) => !available.has(id));
        if (missing.length > 0) {
          return res.status(400).json({
            error: `evalIds not found in this suite: ${missing.join(', ')}`,
            missing,
          });
        }
        const wanted = new Set(body.evalIds);
        evals = evals.filter((e) => wanted.has(e.id));
      }

      const loaded = loadSkillBody(skillId, { skillsDir });
      if (!loaded) {
        return res.status(404).json({ error: 'SKILL.md not found for this skill' });
      }
      const skillInjection = buildSkillInjection(loaded);

      const userId = (req as unknown as { authUserId?: string }).authUserId ?? null;
      const requestedEngine = body.engine;
      let resolved;
      try {
        resolved = await resolveOneShotEngine(config, {
          preferred: requestedEngine ?? 'claude-code',
          userId,
          // An explicit `engine` override is the engine to RUN, not a hint. Pin
          // the fallback chain to just that engine so an unavailable requested
          // engine 400s instead of silently resolving to a different CLI —
          // results from another engine would be misleading. With no override,
          // fall back across the agent CLIs (claude → cursor → codex).
          fallbackChain: requestedEngine ? [requestedEngine] : EVAL_FALLBACK_CHAIN,
        });
      } catch (err) {
        if (err instanceof NoEnginesAvailableError) {
          const error = requestedEngine
            ? `requested engine "${requestedEngine}" is not available — configure its CLI/credentials or omit "engine"`
            : err.message;
          return res.status(400).json({ code: 'no_engines_configured', error });
        }
        return res.status(500).json({ error: (err as Error).message });
      }

      const model = body.model ?? resolved.model;
      const timeoutMs = body.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
      const env = buildSpawnEnv(config, { userId, engine: resolved.engine });

      // Isolation: eval prompts are user-authored and the CLI runs with
      // bypassed permissions, so a prompt could ask the agent to edit files.
      // Each spawn gets its own throwaway temp workspace (NOT the project
      // checkout) so a prompt can't mutate the user's project, and the
      // with-skill and baseline variants can't race each other in a shared
      // tree (which would also contaminate results). All dirs are removed in
      // the finally below.
      const workspaces: string[] = [];
      const runner: OneShotRunner = ({ prompt, systemPrompt }) => {
        const cwd = mkdtempSync(path.join(os.tmpdir(), 'skill-eval-'));
        workspaces.push(cwd);
        return runOneShotPrompt(
          { engine: resolved.engine, model, prompt, systemPrompt, cwd, timeoutMs, env },
          config,
        );
      };

      try {
        const summary = await runSkillEvals({ skillId, skillInjection, evals, runner });
        return res.json({ ...summary, engine: resolved.engine, model });
      } catch (err) {
        return res.status(500).json({ error: (err as Error).message });
      } finally {
        for (const dir of workspaces) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* best-effort cleanup — a leaked temp dir is not worth failing on */
          }
        }
      }
    },
  );

  return router;
}
