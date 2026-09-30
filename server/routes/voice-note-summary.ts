/**
 * POST /api/transcribe/summary — summarize a dictated note transcript with the
 * caller's default model, failing over across engines like sessions do.
 */
import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';
import { EngineAuthRequiredError } from '../per-user-cli-spawn.js';
import {
  summarizeVoiceTranscript,
  NoEnginesAvailableError,
  MAX_VOICE_TRANSCRIPT_CHARS,
} from '../voice-note-summary.js';
import { z, registerPath, registerComponent } from '../openapi/registry.js';

export const VoiceSummaryRequestSchema = z.object({
  transcript: z
    .string()
    .trim()
    .min(1, 'transcript is required')
    .max(MAX_VOICE_TRANSCRIPT_CHARS, 'transcript is too long'),
});

const VoiceSummaryResponse = registerComponent(
  'VoiceSummaryResponse',
  z
    .object({
      summary: z.string().openapi({ description: 'Markdown summary of the transcript.' }),
      engine: z.string(),
      model: z.string(),
    })
    .openapi({ description: 'Summary of a dictated note, plus the engine/model that wrote it.' }),
);

const VoiceSummaryError = registerComponent(
  'VoiceSummaryErrorResponse',
  z.object({ error: z.string(), code: z.string().optional() }),
);

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: VoiceSummaryError } },
});

registerPath({
  method: 'post',
  path: '/api/transcribe/summary',
  tags: ['Transcription'],
  summary: 'Summarize a voice note transcript',
  description:
    "Runs the caller's default model (their Hub engine/model pick) over a dictated transcript and returns a Markdown summary. " +
    'Unauthenticated engines are skipped up front, and a run that dies on quota, auth, or upstream errors fails over to the next engine.',
  request: {
    body: { content: { 'application/json': { schema: VoiceSummaryRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Markdown summary.',
      content: { 'application/json': { schema: VoiceSummaryResponse } },
    },
    400: errorResponse('Invalid body, or engine credentials missing for this account.'),
    401: errorResponse('Authentication required.'),
    502: errorResponse('Every engine failed to produce a summary.'),
    503: errorResponse('No AI engines are configured or available.'),
  },
});

export interface VoiceNoteSummaryRouteOptions {
  summarize?: typeof summarizeVoiceTranscript;
}

export default function createVoiceNoteSummaryRoutes(
  deps: RouteDeps,
  overrides: VoiceNoteSummaryRouteOptions = {},
): Router {
  const router = Router();
  const summarize = overrides.summarize ?? summarizeVoiceTranscript;

  router.post('/api/transcribe/summary', async (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const parsed = VoiceSummaryRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid request body' });
      return;
    }
    try {
      const result = await summarize({
        userId: areq.authUserId,
        transcript: parsed.data.transcript,
        config: deps.config,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof NoEnginesAvailableError) {
        res.status(503).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof EngineAuthRequiredError) {
        res.status(400).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[voice-note-summary]', message);
      res.status(502).json({ error: message });
    }
  });

  return router;
}
