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
 * • Providers: selectable on the settings page via `config.transcriptionProvider`.
 *   The host config setting is authoritative — there is no per-request override.
 *     - `xai` (default) — xAI Grok speech-to-text (`POST https://api.x.ai/v1/stt`,
 *       multipart) with `config.xaiApiKey`. xAI documents WAV / MP3 / OGG /
 *       Opus / FLAC / AAC / MP4 / M4A / MKV but NOT WebM — exactly what Chrome
 *       and Electron record. For an unsupported container the route falls back
 *       to Whisper when `config.openaiApiKey` is set, else returns an
 *       actionable 415.
 *     - `openai` — OpenAI Whisper (`/v1/audio/transcriptions`) with
 *       `config.openaiApiKey`. Accepts every format the composer records.
 * • No persistence: the audio buffer is held in memory long enough to POST to
 *   the provider and then discarded. Only the transcript is returned. This
 *   sidesteps privacy / storage questions from the intake ticket.
 * • Graceful degradation: if the selected provider's API key is not configured
 *   the endpoint returns 501 so the client can fall back to on-device
 *   recognition (Web Speech API on web/Electron) without a hard error.
 * • Size limit: 25 MB (Whisper's documented max per request).
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import type { RouteDeps, TranscriptionProvider } from '../types.js';

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
  'audio/aac',
  'audio/aiff',
  'audio/x-aiff',
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
  'audio/aac': 'aac',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
};

export function normalizeAudioContentType(ct: string | undefined): string | null {
  if (!ct) return null;
  const t = ct.split(';')[0].trim().toLowerCase();
  return ALLOWED_AUDIO_TYPES.has(t) ? t : null;
}

export function extensionForAudioType(contentType: string): string {
  return MIME_TO_EXT[contentType] ?? 'bin';
}

// The content-types this route routes to xAI directly: the INTERSECTION of
// xAI's documented containers and the formats the composer records / this route
// accepts (ALLOWED_AUDIO_TYPES). Deliberately scoped to what callers actually
// send — it is NOT the full xAI list. Notable gaps in each direction:
//   • xAI also documents Opus (`audio/opus`) and MKV (`audio/x-matroska` /
//     `video/x-matroska`). The composer never produces those containers and the
//     route's ALLOWED_AUDIO_TYPES gate rejects them up front, so listing them
//     here would be dead entries — they are intentionally omitted.
//   • WebM and AIFF ARE accepted by this route but are NOT supported by xAI
//     (WebM is exactly what Chrome / Electron's MediaRecorder emits), so they
//     are absent here and take the fallback path below.
// See https://docs.x.ai/developers/model-capabilities/audio/speech-to-text.
const XAI_SUPPORTED_AUDIO_TYPES: ReadonlySet<string> = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/aac',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
]);

// Distinct user-facing container labels surfaced in the 415 `accepted` response.
// Mirrors XAI_SUPPORTED_AUDIO_TYPES (the containers this route sends to xAI).
const XAI_ACCEPTED_MIMES: readonly string[] = [
  'audio/wav',
  'audio/mp3',
  'audio/ogg',
  'audio/flac',
  'audio/aac',
  'audio/mp4',
  'audio/m4a',
];

/**
 * Whether this route forwards `contentType` to xAI directly. True only for the
 * intersection of xAI's documented containers and ALLOWED_AUDIO_TYPES — see
 * XAI_SUPPORTED_AUDIO_TYPES for why Opus/MKV and WebM/AIFF are each excluded.
 */
export function isXaiSupportedAudioType(contentType: string): boolean {
  return XAI_SUPPORTED_AUDIO_TYPES.has(contentType);
}

/**
 * Resolves the transcription provider from the host config. The Account-settings
 * choice (`config.transcriptionProvider`) is authoritative — there is no
 * per-request override, so a caller cannot force another configured
 * provider/key. Unknown / unset values resolve to the safe default (`xai`).
 */
export function resolveTranscriptionProvider(
  configured: TranscriptionProvider | string | null | undefined,
): TranscriptionProvider {
  const v = String(configured ?? '')
    .trim()
    .toLowerCase();
  if (v === 'openai') return 'openai';
  return 'xai';
}

export interface XaiSttResponse {
  text?: string;
  language?: string;
  duration?: number;
  error?: { message?: string } | string;
}

/**
 * Transcribes audio with the xAI Grok speech-to-text endpoint
 * (`POST https://api.x.ai/v1/stt`). The audio is sent as `multipart/form-data`
 * with a Bearer token; xAI auto-detects the container, so no model parameter is
 * sent. Per the xAI docs the `file` part MUST come after all other fields, so
 * optional fields (`language`) are appended first and `file` last. Exported for
 * test-level mocking; `fetchImpl` defaults to the global `fetch`.
 * See https://docs.x.ai/developers/model-capabilities/audio/speech-to-text.
 */
export async function transcribeWithXai(opts: {
  apiKey: string;
  audio: Buffer;
  contentType: string;
  language?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { apiKey, audio, contentType, language } = opts;
  const fetchFn = opts.fetchImpl ?? fetch;

  const filename = `audio.${extensionForAudioType(contentType)}`;
  const form = new FormData();
  // xAI requires the `file` part to be appended AFTER every other field, so all
  // optional fields go first. Copy into a fresh Uint8Array so the underlying
  // buffer type is ArrayBuffer, not Node's Buffer-backed ArrayBufferLike
  // (Blob's BlobPart is stricter under TS's lib.dom types).
  if (language) form.append('language', language);
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  form.append('file', new Blob([bytes], { type: contentType }), filename);

  const res = await fetchFn('https://api.x.ai/v1/stt', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const body = (await res.json().catch(() => ({}))) as XaiSttResponse;

  if (!res.ok) {
    const msg =
      (typeof body?.error === 'string' ? body.error : body?.error?.message) ||
      `xAI STT request failed (HTTP ${res.status})`;
    throw Object.assign(new Error(msg), { status: res.status });
  }

  if (typeof body.text !== 'string') {
    throw Object.assign(new Error('xAI STT response missing `text`'), { status: 502 });
  }

  return body.text;
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
        // The host config setting is authoritative; we deliberately do NOT
        // honor a per-request provider override so a caller can't force the
        // other configured provider/key against the admin's choice.
        const provider = resolveTranscriptionProvider(config.transcriptionProvider);

        // Validate the upload first (provider-independent), then resolve keys
        // per-provider. The key check is intentionally NOT hoisted above the
        // provider branches: the xAI branch can fall back to OpenAI Whisper when
        // it can't serve the request (unsupported container OR no xAI key), so a
        // missing xAI key must not short-circuit to 501 before that fallback.
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

        // 501 signals "not configured" so the client can transparently fall back
        // to the Web Speech API on web/Electron.
        const notConfigured = (label: string) =>
          res.status(501).json({
            error: 'Transcription not configured',
            provider,
            hint: `Set the ${label} API key in Account settings (or change the transcription provider) or use on-device transcription.`,
          });

        if (provider === 'xai') {
          // Use xAI only when its key is set AND it documents this container.
          if (config.xaiApiKey && isXaiSupportedAudioType(contentType)) {
            const transcript = await transcribeWithXai({
              apiKey: config.xaiApiKey,
              audio: buf,
              contentType,
              language,
            });

            return res.json({ transcript, provider: 'xai' });
          }

          // xAI can't serve this — either the container is one it doesn't
          // document (canonically the `audio/webm` Chrome / Electron record) or
          // no xAI key is configured. Whisper accepts every format the composer
          // records, so when an OpenAI key is present we transparently fall back
          // rather than fail the default provider's happy path (this also keeps
          // installs that only ever configured OpenAI working unchanged). The
          // response reports the provider actually used plus `fallbackFrom` so
          // callers can observe the substitution.
          if (config.openaiApiKey) {
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
              fallbackFrom: 'xai',
            });
          }

          // No fallback available. Distinguish the two failure reasons so the
          // client gets an actionable response instead of an opaque error.
          if (!config.xaiApiKey) {
            // Nothing configured at all → 501 so the client falls back on-device.
            return notConfigured('xAI');
          }
          // xAI key present but the container is unsupported and no OpenAI
          // fallback is configured → 415.
          return res.status(415).json({
            error: `xAI cannot transcribe ${contentType} audio`,
            provider: 'xai',
            accepted: XAI_ACCEPTED_MIMES,
            hint: 'Record in WAV / MP3 / OGG / FLAC / AAC / MP4 / M4A, configure an OpenAI API key for automatic fallback, or switch the transcription provider.',
          });
        }

        if (!config.openaiApiKey) return notConfigured('OpenAI');

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
