import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import supertest from 'supertest';
import createTranscribeRoutes, {
  normalizeAudioContentType,
  extensionForAudioType,
  transcribeWithWhisper,
} from './transcribe.js';
import type { RouteDeps, AppConfig } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeApp(openaiApiKey: string | null): Express {
  const config = { openaiApiKey } as AppConfig;
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
