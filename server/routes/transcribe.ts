/**
 * POST /api/transcribe
 *
 * Server-side speech-to-text for the Agent Hub chat composer. Accepts a raw
 * audio body (webm / mp4 / m4a / mp3 / wav / ogg / flac) and returns the
 * transcribed text. Used by mobile (no Web Speech API) and by web/Electron
 * clients that prefer Whisper-grade accuracy over on-device recognition.
 *
 * Design notes
 * ─────────────
 * • Provider: OpenAI Whisper (`/v1/audio/transcriptions`). Chosen for latency,
 *   accuracy, and minimal setup — single env var (`OPENAI_API_KEY`).
 * • No persistence: the audio buffer is held in memory long enough to POST to
 *   the provider and then discarded. Only the transcript is returned. This
 *   sidesteps privacy / storage questions from the intake ticket.
 * • Graceful degradation: if the server is not configured with an API key the
 *   endpoint returns 501 so the client can fall back to on-device recognition
 *   (Web Speech API on web/Electron) without a hard error.
 * • Size limit: 25 MB (Whisper's documented max per request).
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import type { RouteDeps } from '../types.js';

const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB — Whisper per-request limit

// Content types the Whisper API accepts. We keep this narrow so callers can't
// proxy arbitrary binaries through a public endpoint.
const ALLOWED_AUDIO_TYPES: ReadonlySet<string> = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/flac',
  'audio/x-flac',
]);

const MIME_TO_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

export function normalizeAudioContentType(ct: string | undefined): string | null {
  if (!ct) return null;
  const t = ct.split(';')[0].trim().toLowerCase();
  return ALLOWED_AUDIO_TYPES.has(t) ? t : null;
}

export function extensionForAudioType(contentType: string): string {
  return MIME_TO_EXT[contentType] ?? 'bin';
}

export interface WhisperResponse {
  text?: string;
  error?: { message?: string; type?: string; code?: string };
}

/**
 * Calls OpenAI Whisper. Exported for test-level mocking without touching the
 * Express router. `fetchImpl` defaults to the global `fetch` so tests can
 * inject a stub.
 */
export async function transcribeWithWhisper(opts: {
  apiKey: string;
  audio: Buffer;
  contentType: string;
  language?: string;
  fetchImpl?: typeof fetch;
  model?: string;
}): Promise<string> {
  const { apiKey, audio, contentType, language, model = 'whisper-1' } = opts;
  const fetchFn = opts.fetchImpl ?? fetch;

  const filename = `audio.${extensionForAudioType(contentType)}`;
  const form = new FormData();
  // Node 18+ exposes Blob globally.
  // Copy into a fresh Uint8Array so the underlying buffer type is ArrayBuffer,
  // not Node's Buffer-backed ArrayBufferLike (Blob's BlobPart is stricter
  // under TS's lib.dom types).
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const res = await fetchFn('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const body = (await res.json().catch(() => ({}))) as WhisperResponse;

  if (!res.ok) {
    const msg = body?.error?.message || `Whisper request failed (HTTP ${res.status})`;
    throw Object.assign(new Error(msg), { status: res.status });
  }

  if (typeof body.text !== 'string') {
    throw Object.assign(new Error('Whisper response missing `text`'), { status: 502 });
  }

  return body.text;
}

export default function createTranscribeRoutes(deps: RouteDeps): Router {
  const { config } = deps;
  const router = Router();

  router.post(
    '/api/transcribe',
    express.raw({ type: 'audio/*', limit: MAX_AUDIO_SIZE + 1024 }),
    async (req: Request, res: Response) => {
      try {
        if (!config.openaiApiKey) {
          // 501 signals "not configured" so the client can transparently
          // fall back to Web Speech API on web/Electron.
          return res.status(501).json({
            error: 'Transcription not configured',
            hint: 'Set OPENAI_API_KEY on the server or use on-device transcription.',
          });
        }

        const contentType = normalizeAudioContentType(
          req.headers['content-type'] as string | undefined,
        );
        if (!contentType) {
          return res.status(415).json({
            error: 'Unsupported audio content-type',
            accepted: Array.from(ALLOWED_AUDIO_TYPES),
          });
        }

        const buf = req.body as Buffer;
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
          return res.status(400).json({ error: 'Empty audio body' });
        }
        if (buf.length > MAX_AUDIO_SIZE) {
          return res.status(413).json({
            error: `Audio too large. Max size: ${MAX_AUDIO_SIZE / 1024 / 1024}MB`,
          });
        }

        const language = (req.headers['x-language'] as string | undefined)?.slice(0, 8);

        const transcript = await transcribeWithWhisper({
          apiKey: config.openaiApiKey,
          audio: buf,
          contentType,
          language,
        });

        return res.json({
          transcript,
          provider: 'openai-whisper',
          model: 'whisper-1',
        });
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status ?? 500;
        const message = err instanceof Error ? err.message : String(err);
        console.error('Transcription error:', message);
        return res.status(status >= 400 && status < 600 ? status : 502).json({
          error: 'Transcription failed',
          detail: message,
        });
      }
    },
  );

  return router;
}
