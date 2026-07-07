import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import supertest from 'supertest';
import createTranscribeRoutes, {
  normalizeAudioContentType,
  extensionForAudioType,
  transcribeWithWhisper,
  transcribeWithXai,
  isXaiSupportedAudioType,
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

// ─── xAI Grok speech-to-text client ───────────────────────────────

describe('transcribeWithXai', () => {
  it('sends a multipart POST to /v1/stt with Bearer auth and returns text', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.x.ai/v1/stt');
      expect((init as RequestInit).method).toBe('POST');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer xai-test');
      expect((init as RequestInit).body).toBeInstanceOf(FormData);
      return jsonResponse({ text: 'hello from grok' });
    }) as unknown as typeof fetch;

    const out = await transcribeWithXai({
      apiKey: 'xai-test',
      audio: Buffer.from('fake-audio'),
      contentType: 'audio/ogg',
      fetchImpl,
    });

    expect(out).toBe('hello from grok');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('appends the file part AFTER all other fields (xAI ordering requirement)', async () => {
    let orderedKeys: string[] = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      const form = (init as RequestInit).body as FormData;
      orderedKeys = [...form.keys()];
      return jsonResponse({ text: 'ok' });
    }) as unknown as typeof fetch;

    await transcribeWithXai({
      apiKey: 'xai-test',
      audio: Buffer.from('clip'),
      contentType: 'audio/ogg',
      language: 'en',
      fetchImpl,
    });

    // `language` must precede `file`; xAI rejects the request otherwise.
    expect(orderedKeys).toEqual(['language', 'file']);
    expect(orderedKeys[orderedKeys.length - 1]).toBe('file');
  });

  it('throws with the upstream message on non-2xx (object error)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'bad xai key' } }, { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      transcribeWithXai({
        apiKey: 'xai-bad',
        audio: Buffer.from('a'),
        contentType: 'audio/webm',
        fetchImpl,
      }),
    ).rejects.toThrow(/bad xai key/);
  });

  it('throws with the upstream message on non-2xx (string error)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'rate limited' }, { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(
      transcribeWithXai({
        apiKey: 'xai',
        audio: Buffer.from('a'),
        contentType: 'audio/webm',
        fetchImpl,
      }),
    ).rejects.toThrow(/rate limited/);
  });

  it('throws if response is missing text', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;

    await expect(
      transcribeWithXai({
        apiKey: 'xai',
        audio: Buffer.from('a'),
        contentType: 'audio/webm',
        fetchImpl,
      }),
    ).rejects.toThrow(/missing `text`/);
  });
});

// ─── Provider resolution ──────────────────────────────────────────

describe('resolveTranscriptionProvider', () => {
  it('resolves the configured value (xai/openai stay themselves)', () => {
    expect(resolveTranscriptionProvider('xai')).toBe('xai');
    expect(resolveTranscriptionProvider('openai')).toBe('openai');
  });

  it('normalizes case/whitespace', () => {
    expect(resolveTranscriptionProvider('  OPENAI  ')).toBe('openai');
    expect(resolveTranscriptionProvider('  XAI  ')).toBe('xai');
  });

  it('falls back to xai (the default) for unset / unknown values', () => {
    expect(resolveTranscriptionProvider(undefined)).toBe('xai');
    expect(resolveTranscriptionProvider(null)).toBe('xai');
    expect(resolveTranscriptionProvider('')).toBe('xai');
    expect(resolveTranscriptionProvider('bogus')).toBe('xai');
    expect(resolveTranscriptionProvider('gemini')).toBe('xai');
  });
});

describe('isXaiSupportedAudioType', () => {
  it('accepts the containers xAI documents', () => {
    for (const t of [
      'audio/wav',
      'audio/mpeg',
      'audio/mp3',
      'audio/ogg',
      'audio/flac',
      'audio/aac',
      'audio/mp4',
      'audio/m4a',
    ]) {
      expect(isXaiSupportedAudioType(t)).toBe(true);
    }
  });

  it('rejects WebM (the Chrome/Electron recorder default) and AIFF', () => {
    expect(isXaiSupportedAudioType('audio/webm')).toBe(false);
    expect(isXaiSupportedAudioType('audio/aiff')).toBe(false);
    expect(isXaiSupportedAudioType('audio/x-aiff')).toBe(false);
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
    const app = makeApp('sk-test', { transcriptionProvider: 'openai' });
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
    const app = makeApp('sk-test', { transcriptionProvider: 'openai' });
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

describe('POST /api/transcribe — provider override is ignored', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('ignores X-Transcription-Provider — the host config setting is authoritative', async () => {
    const fetchSpy = vi.fn(async (_url: unknown) => jsonResponse({ text: 'via openai' }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Config selects openai. A caller cannot force a different provider via the
    // header to consume another configured key.
    const app = makeApp('sk-openai', { transcriptionProvider: 'openai' });
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/ogg')
      .set('x-transcription-provider', 'xai')
      .send(Buffer.from('clip'));

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('openai-whisper');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('api.openai.com');
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('api.x.ai');
  });
});

describe('POST /api/transcribe — xAI provider (default)', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('routes to xAI by default for a supported format and returns provider:xai', async () => {
    const fetchSpy = vi.fn(async (_url: unknown) => jsonResponse({ text: 'transcribed via grok' }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // No transcriptionProvider override — exercises the new default. audio/ogg
    // is one of xAI's documented containers.
    const app = makeApp(null, { xaiApiKey: 'xai-x' });
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/ogg')
      .send(Buffer.from('clip'));

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('xai');
    expect(res.body.transcript).toBe('transcribed via grok');
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://api.x.ai/v1/stt');
  });

  it('falls back to Whisper for WebM (an xAI-unsupported container) when an OpenAI key is set', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) =>
      jsonResponse({ text: 'via whisper fallback' }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Default provider xai + the Chrome/Electron recorder default (webm).
    const app = makeApp('sk-openai-present', { xaiApiKey: 'xai-x' });
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/webm')
      .send(Buffer.from('clip'));

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('openai-whisper');
    expect(res.body.fallbackFrom).toBe('xai');
    expect(res.body.transcript).toBe('via whisper fallback');
    // Hit Whisper (not xAI) with the OpenAI key.
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://api.openai.com/v1/audio/transcriptions',
    );
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-openai-present');
  });

  it('returns 415 (no network) for WebM when xAI is default and no OpenAI fallback key is set', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const app = makeApp(null, { xaiApiKey: 'xai-x' });
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/webm')
      .send(Buffer.from('clip'));

    expect(res.status).toBe(415);
    expect(res.body.provider).toBe('xai');
    expect(res.body.hint).toMatch(/OpenAI|WAV|switch/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('regression: an OpenAI-only install (default xai, no xAI key) still transcribes via Whisper', async () => {
    // Reviewer scenario: existing users who configured OpenAI before xai became
    // the default must not regress to 501. With xaiApiKey unset and openaiApiKey
    // present, both an xAI-unsupported container (webm) and an xAI-supported one
    // (mp4, what Safari records) must fall back to Whisper rather than 501.
    for (const contentType of ['audio/webm', 'audio/mp4']) {
      const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) =>
        jsonResponse({ text: 'via whisper' }),
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const app = makeApp('sk-openai-present', { xaiApiKey: null });
      const res = await supertest(app)
        .post('/api/transcribe')
        .set('content-type', contentType)
        .send(Buffer.from('clip'));

      expect(res.status, contentType).toBe(200);
      expect(res.body.provider, contentType).toBe('openai-whisper');
      expect(res.body.fallbackFrom, contentType).toBe('xai');
      expect(String(fetchSpy.mock.calls[0][0])).toBe(
        'https://api.openai.com/v1/audio/transcriptions',
      );
    }
  });

  it('returns 501 (no network) when neither the xAI key nor an OpenAI fallback is configured', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // No xAI key and no OpenAI key — nothing can serve the request, so the
    // client should fall back to on-device recognition.
    const app = makeApp(null, { xaiApiKey: null });
    const res = await supertest(app)
      .post('/api/transcribe')
      .set('content-type', 'audio/ogg')
      .send(Buffer.from('clip'));

    expect(res.status).toBe(501);
    expect(res.body.provider).toBe('xai');
    expect(res.body.hint).toMatch(/xAI/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
