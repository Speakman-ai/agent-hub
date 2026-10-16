/**
 * Routines from recorded demos (SPEC-7).
 *
 * `POST /api/sessions/:sessionId/routines/draft` hands a browser demo
 * recording (a session artifact) to the session's agent, which drafts a
 * project skill from it. The draft comes back for the human to edit in the
 * Make routine dialog; saving goes through the project skills API and the
 * schedule through `POST /api/crons` with `routine_skill`.
 */
import { Router, type Request, type Response } from 'express';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ArtifactRow, RouteDeps, SessionRow } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { getSessionOwner, resolveOwnerUserId, userOwnsSession } from '../session-ownership.js';
import { findAgent } from '../project-model.js';
import {
  ArtifactStoreUnavailableError,
  getArtifactStoreForLocation,
} from '../artifacts/artifact-store.js';
import { NoEnginesAvailableError, resolveOneShotEngine } from '../engine-resolver.js';
import { runOneShotPrompt } from '../one-shot-spawn.js';
import { buildSpawnEnv } from '../config.js';
import { resolveUserCliCredOverride } from '../per-user-cli-spawn.js';
import {
  buildRoutineDraftPrompt,
  extractRoutineDraft,
  parseDemoRecording,
  suggestRoutineSkillName,
} from '../routine-draft.js';
import { RoutineDraftRequestSchema } from './routines.openapi.js';

/** One model call; the client waits up to `ROUTINE_DRAFT_TIMEOUT_MS` for it. */
export const ROUTINE_DRAFT_SPAWN_TIMEOUT_MS = 180_000;
/** Recordings are capped at 5k steps; anything far larger is not one. */
const MAX_RECORDING_BYTES = 8 * 1024 * 1024;

export default function createRoutineRoutes(deps: RouteDeps): Router {
  const { stmts, config } = deps;
  const router = Router();

  router.post('/api/sessions/:sessionId/routines/draft', async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const parsed = RoutineDraftRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' });
    }
    const { artifactId, goal } = parsed.data;

    const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const found = findAgent(session.agent_id);
    if (!found?.project) {
      return res.status(400).json({ error: 'Session has no project to save a routine in' });
    }
    const { project, agent } = found;

    const row = stmts.getArtifact.get(artifactId) as ArtifactRow | undefined;
    if (!row || row.session_id !== sessionId) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
    if (row.size > MAX_RECORDING_BYTES) {
      return res.status(400).json({ error: 'Artifact is not a browser demo recording' });
    }
    let raw: Buffer;
    try {
      raw = await getArtifactStoreForLocation(row, config).getBuffer(row.storage_key);
    } catch (err) {
      if (err instanceof ArtifactStoreUnavailableError) {
        return res.status(503).json({ error: err.message });
      }
      return res.status(500).json({ error: 'Failed to read the recording' });
    }
    const recording = parseDemoRecording(raw);
    if (!recording) {
      return res.status(400).json({ error: 'Artifact is not a browser demo recording' });
    }
    if (recording.steps.length === 0) {
      return res.status(400).json({ error: 'The recording has no steps to turn into a routine' });
    }

    // Built before any model or engine work: a recording the parser accepted
    // should always format, but a failure here is still the artifact's fault.
    let prompt: string;
    try {
      prompt = buildRoutineDraftPrompt({
        recording,
        projectName: project.name,
        agentName: agent.name,
        goal,
      });
    } catch {
      return res.status(400).json({ error: 'Artifact is not a browser demo recording' });
    }

    const userId =
      getSessionOwner(sessionId) ?? resolveOwnerUserId(req as AuthenticatedRequest) ?? null;
    let resolved;
    try {
      resolved = await resolveOneShotEngine(config, {
        preferred: agent.engine || 'claude-code',
        preferredModel: agent.model ?? null,
        userId,
        agentId: agent.id,
      });
    } catch (err) {
      if (err instanceof NoEnginesAvailableError) {
        return res.status(400).json({ code: 'no_engines_configured', error: err.message });
      }
      return res.status(500).json({ error: (err as Error).message });
    }

    const env = buildSpawnEnv(config, {
      userId,
      userOverride: resolveUserCliCredOverride(userId),
      engine: resolved.engine,
    });
    // The draft is text only, so the CLI gets a throwaway cwd rather than the
    // project checkout.
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'routine-draft-'));
    try {
      const output = await runOneShotPrompt(
        {
          engine: resolved.engine,
          model: resolved.model,
          prompt,
          cwd,
          timeoutMs: ROUTINE_DRAFT_SPAWN_TIMEOUT_MS,
          env,
        },
        config,
      );
      const draft = extractRoutineDraft(
        String(output),
        suggestRoutineSkillName(goal || row.filename),
      );
      if (!draft) {
        return res.status(502).json({ error: 'The agent returned an empty draft. Try again.' });
      }
      return res.json({
        projectId: project.id,
        agentId: agent.id,
        agentName: agent.name,
        artifactId,
        steps: recording.steps.length,
        engine: resolved.engine,
        model: resolved.model ?? null,
        draft,
      });
    } catch (err) {
      return res.status(502).json({ error: `Drafting failed: ${(err as Error).message}` });
    } finally {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* a leaked temp dir is not worth failing the request */
      }
    }
  });

  return router;
}
