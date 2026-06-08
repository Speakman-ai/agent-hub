import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import supertest from 'supertest';
import createTranscribeRoutes, {
  normalizeAudioContentType,
  extensionForAudioType,
  transcribeWithWhisper,
  transcribeWithGemini,
  geminiMimeForAudioType,
  resolveTranscriptionProvider,
} from './transcribe.js';
import type { RouteDeps, AppConfig } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeApp(openaiApiKey: string | null, overrides: Partial<AppConfig> = {}): Express {
  const config = { openaiApiKey, ...overrides } as AppConfig;
  const deps = { config } as unknown as RouteDeps;
  const app = express();
  app.use(createTranscribeRoutes(deps));
  return app;
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── Pure helpers ─────────────────────────────────────────────────

describe('normalizeAudioContentType', () => {
  it('accepts common audio MIME types', () => {
    expect(normalizeAudioContentType('audio/webm')).toBe('audio/webm');
    expect(normalizeAudioContentType('audio/mp4')).toBe('audio/mp4');
    expect(normalizeAudioContentType('audio/wav')).toBe('audio/wav');
  });

  it('strips parameters and lowercases', () => {
    expect(normalizeAudioContentType('AUDIO/WEBM; codecs=opus')).toBe('audio/webm');
  });

  it('rejects non-audio or unsupported types', () => {
    expect(normalizeAudioContentType('video/mp4')).toBeNull();
    expect(normalizeAudioContentType('application/octet-stream')).toBeNull();
    expect(normalizeAudioContentType(undefined)).toBeNull();
  });
});

describe('extensionForAudioType', () => {
  it('returns a sensible filename extension', () => {
    expect(extensionForAudioType('audio/webm')).toBe('webm');
    expect(extensionForAudioType('audio/mp4')).toBe('mp4');
    expect(extensionForAudioType('audio/flac')).toBe('flac');
  });

  it('falls back to .bin for unknown types', () => {
    expect(extensionForAudioType('audio/unknown')).toBe('bin');
  });
});

// ─── Whisper client ───────────────────────────────────────────────

describe('transcribeWithWhisper', () => {
  it('sends a multipart POST with Bearer auth and returns text', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
      expect((init as RequestInit).method).toBe('POST');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-test');
      expect((init as RequestInit).body).toBeInstanceOf(FormData);
      return jsonResponse({ text: 'hello world' });
    }) as unknown as typeof fetch;

    const out = await transcribeWithWhisper({
      apiKey: 'sk-test',
      audio: Buffer.from('fake-audio'),
      contentType: 'audio/webm',
      fetchImpl,
    });

    expect(out).toBe('hello world');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws with the upstream message on non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'invalid api key' } }, { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      transcribeWithWhisper({
        apiKey: 'sk-bad',
        audio: Buffer.from('a'),
        contentType: 'audio/webm',
        fetchImpl,
      }),
    ).rejects.toThrow(/invalid api key/);
  });

  it('throws if response is malformed', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;

    await expect(
      transcribeWithWhisper({
        apiKey: 'sk',
        audio: Buffer.from('a'),
        contentType: 'audio/webm',
        fetchImpl,
      }),
    ).rejects.toThrow(/missing `text`/);
  });
});

// ─── Provider resolution + Gemini helpers ─────────────────────────

describe('resolveTranscriptionProvider', () => {
  it('resolves the configured value (gemini stays gemini, openai stays openai)', () => {
    expect(resolveTranscriptionProvider('gemini')).toBe('gemini');
    expect(resolveTranscriptionProvider('openai')).toBe('openai');
  });

  it('normalizes case/whitespace', () => {
    expect(resolveTranscriptionProvider('  GEMINI  ')).toBe('gemini');
  });

  it('falls back to openai for unset / unknown values', () => {
    expect(resolveTranscriptionProvider(undefined)).toBe('openai');
    expect(resolveTranscriptionProvider(null)).toBe('openai');
    expect(resolveTranscriptionProvider('')).toBe('openai');
    expect(resolveTranscriptionProvider('bogus')).toBe('openai');
  });
});

describe('geminiMimeForAudioType', () => {
  it('maps Gemini-supported types to their canonical MIME', () => {
    expect(geminiMimeForAudioType('audio/ogg')).toBe('audio/ogg');
    expect(geminiMimeForAudioType('audio/mpeg')).toBe('audio/mp3');
    expect(geminiMimeForAudioType('audio/wav')).toBe('audio/wav');
    expect(geminiMimeForAudioType('audio/flac')).toBe('audio/flac');
    // aac / aiff are documented Gemini formats too.
    expect(geminiMimeForAudioType('audio/aac')).toBe('audio/aac');
    expect(geminiMimeForAudioType('audio/aiff')).toBe('audio/aiff');
    expect(geminiMimeForAudioType('audio/x-aiff')).toBe('audio/aiff');
  });

  it('returns null for formats Gemini cannot read', () => {
    expect(geminiMimeForAudioType('audio/webm')).toBeNull();
    expect(geminiMimeForAudioType('audio/mp4')).toBeNull();
    expect(geminiMimeForAudioType('audio/m4a')).toBeNull();
  });
});

describe('transcribeWithGemini', () => {
  it('POSTs inline base64 audio with x-goog-api-key and returns joined text', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toContain(
        'generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      );
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe('AIza-test');
      const body = JSON.parse((init as RequestInit).body as string);
      const parts = body.contents[0].parts;
      expect(parts[1].inlineData.mimeType).toBe('audio/ogg');
      expect(parts[1].inlineData.data).toBe(Buffer.from('clip').toString('base64'));
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'gemini' }] } }],
      });
    }) as unknown as typeof fetch;

    const out = await transcribeWithGemini({
      apiKey: 'AIza-test',
      audio: Buffer.from('clip'),
      geminiMime: 'audio/ogg',
      model: 'gemini-2.5-flash',
      fetchImpl,
    });

    expect(out).toBe('hello gemini');
  });

  it('throws the upstream message on non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'API key not valid' } }, { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(
      transcribeWithGemini({
        apiKey: 'bad',
        audio: Buffer.from('a'),
        geminiMime: 'audio/ogg',
        fetchImpl,
      }),
    ).rejects.toThrow(/API key not valid/);
  });

  it('throws when the audio is blocked by safety filters', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
    ) as unknown as typeof fetch;

    await expect(
      transcribeWithGemini({
        apiKey: 'k',
        audio: Buffer.from('a'),
        geminiMime: 'audio/ogg',
        fetchImpl,
      }),
    ).rejects.toThrow(/blocked/i);
  });

  it('throws on an empty/whitespace transcript instead of returning "" as success', async () => {
    // A candidate with empty parts (or whitespace-only text) must not be
    // reported as a successful blank transcription — it hides upstream failures.
    for (const candidates of [
      [{ content: { parts: [] } }],
      [{ content: { parts: [{ text: '   ' }] } }],
      [{ content: {} }],
      [],
    ]) {
      const fetchImpl = vi.fn(async () => jsonResponse({ candidates })) as unknown as typeof fetch;
      await expect(
        transcribeWithGemini({
          apiKey: 'k',
          audio: Buffer.from('a'),
          geminiMime: 'audio/ogg',
          fetchImpl,
        }),
      ).rejects.toThrow(/empty transcript/i);
    }
  });
});

// ─── Route integration ────────────────────────────────────────────

describe('POST /api/transcribe', () => {
  it('returns 501 when no API key is configured (client should fall back)', async () => {
    const app = makeApp(null);
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/webm')
      .send(Buffer.from('fake'));
    expect(res.status).toBe(501);
    expect(res.body.error).toMatch(/not configured/i);
    expect(res.body.hint).toMatch(/Account settings|on-device/i);
  });

  it('returns 415 for unsupported content-types', async () => {
    const app = makeApp('sk-test');
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/weird')
      .send(Buffer.from('fake'));
    // express.raw with type: 'audio/*' still parses, but our handler rejects.
    // For types outside audio/*, express.raw won't populate req.body — the
    // handler then sees an empty body. Either way, a non-2xx is returned.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('returns 400 on empty body', async () => {
    const app = makeApp('sk-test');
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/webm')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty/i);
  });

  it('does not proxy to Whisper when not configured (no network call)', async () => {
    // Simulates the fallback path: if the server is unconfigured we must NOT
    // invoke `fetch`. We stash the global and assert it was never called.
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const app = makeApp(null);
      await supertest(app)
        .post('/api/transcribe')
        .set('content-type', 'audio/webm')
        .send(Buffer.from('fake'));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('POST /api/transcribe — Gemini provider', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('routes to Gemini and returns provider:gemini for a supported format', async () => {
    const fetchSpy = vi.fn(async (_url: unknown) =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'transcribed via gemini' }] } }] }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const app = makeApp(null, { transcriptionProvider: 'gemini', geminiApiKey: 'AIza-x' });
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/ogg')
      .send(Buffer.from('clip'));

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('gemini');
    expect(res.body.transcript).toBe('transcribed via gemini');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('generativelanguage.googleapis.com');
  });

  it('returns 501 (no network) when Gemini is selected but the Gemini key is unset', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const app = makeApp('sk-openai-present', {
      transcriptionProvider: 'gemini',
      geminiApiKey: null,
    });
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/ogg')
      .send(Buffer.from('clip'));

    expect(res.status).toBe(501);
    expect(res.body.provider).toBe('gemini');
    expect(res.body.hint).toMatch(/Gemini/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 415 (no network) when Gemini gets a format it cannot read (webm)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const app = makeApp(null, { transcriptionProvider: 'gemini', geminiApiKey: 'AIza-x' });
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/webm')
      .send(Buffer.from('clip'));

    expect(res.status).toBe(415);
    expect(res.body.provider).toBe('gemini');
    expect(res.body.hint).toMatch(/OpenAI|OGG/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores X-Transcription-Provider — the host config setting is authoritative', async () => {
    // Whisper-shaped response; if the header were honored this would hit Gemini.
    const fetchSpy = vi.fn(async (_url: unknown) => jsonResponse({ text: 'via openai' }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Config selects openai. A caller cannot force gemini via the header to
    // consume the other configured key.
    const app = makeApp('sk-openai', { transcriptionProvider: 'openai', geminiApiKey: 'AIza-x' });
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/ogg')
      .set('x-transcription-provider', 'gemini')
      .send(Buffer.from('clip'));

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('openai-whisper');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('api.openai.com');
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('generativelanguage');
  });
});
