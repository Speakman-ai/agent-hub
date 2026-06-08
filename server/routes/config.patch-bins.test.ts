/**
 * Regression coverage for PATCH /api/config persisting every engine's bin
 * path AND applying it to the in-memory CLAUDE_BIN / CURSOR_BIN / GEMINI_BIN
 * / CODEX_BIN module variables that chat.ts reads via the get*Bin() closures.
 *
 * The bug this guards:
 *   - User pastes `/home/agenthub/.local/bin/codex` in Settings, hits Save.
 *   - UI POSTs `{ codexBin: "..." }` via `api.updateConfig`.
 *   - Server drops `codexBin` because it wasn't in the route allowlist.
 *   - Save appears to succeed (200 OK) but config.json is never touched.
 *   - Next codex turn spawns `/usr/local/bin/codex` (the stale default) and
 *     fails with `codex-cli exited with code -2` (ENOENT on spawn).
 *
 * The fix covers the allowlist gap AND the "config.codexBin updated but
 * module-level CODEX_BIN still stale until restart" follow-on: now the
 * handler also calls deps.setCodexBin (and the sibling setters) so
 * subsequent spawns see the new path immediately.
 */
import type TestAgent from 'supertest/lib/agent.js';
import { readFileSync } from 'fs';
import path from 'path';
import { vi } from 'vitest';
import { getRequest } from '../test/helpers.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PATCH /api/config — engine bin paths', () => {
  const configPath = path.join(process.env.AGENT_HUB_DATA_DIR!, 'config.json');

  function readFileConfig(): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  it('persists codexBin to config.json', async () => {
    const newPath = '/tmp/test-codex-' + process.pid;
    const res = await request.patch('/api/config').send({ codexBin: newPath }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toEqual({ codexBin: newPath });
    expect(readFileConfig().codexBin).toBe(newPath);
  });

  it('reflects the new codexBin on the next GET /api/config without a restart', async () => {
    const newPath = '/tmp/test-codex-live-' + process.pid;
    await request.patch('/api/config').send({ codexBin: newPath }).expect(200);
    const res = await request.get('/api/config').expect(200);
    // This property didn't exist in the GET payload before the fix — guards
    // the UI's `setEdits({ codexBin: data.codexBin })` bootstrap path.
    expect(res.body.codexBin).toBe(newPath);
    expect(res.body._file.codexBin).toBe(newPath);
  });

  it('persists cursorBin, geminiBin, and claudeBin too (sibling engines)', async () => {
    const suffix = '-' + process.pid;
    await request
      .patch('/api/config')
      .send({
        claudeBin: '/tmp/test-claude' + suffix,
        cursorBin: '/tmp/test-cursor' + suffix,
        geminiBin: '/tmp/test-gemini' + suffix,
      })
      .expect(200);

    const fileCfg = readFileConfig();
    expect(fileCfg.claudeBin).toBe('/tmp/test-claude' + suffix);
    expect(fileCfg.cursorBin).toBe('/tmp/test-cursor' + suffix);
    expect(fileCfg.geminiBin).toBe('/tmp/test-gemini' + suffix);

    const res = await request.get('/api/config').expect(200);
    expect(res.body.claudeBin).toBe('/tmp/test-claude' + suffix);
    expect(res.body.cursorBin).toBe('/tmp/test-cursor' + suffix);
    expect(res.body.geminiBin).toBe('/tmp/test-gemini' + suffix);
  });

  it('persists codexDangerBypass and exposes it on GET /api/config', async () => {
    await request.patch('/api/config').send({ codexDangerBypass: true }).expect(200);
    expect(readFileConfig().codexDangerBypass).toBe(true);
    const res = await request.get('/api/config').expect(200);
    expect(res.body.codexDangerBypass).toBe(true);
    await request.patch('/api/config').send({ codexDangerBypass: false }).expect(200);
    expect(readFileConfig().codexDangerBypass).toBe(false);
  });

  it('persists lanMode and exposes it on GET /api/config', async () => {
    // Defaults to false on fresh installs — GET surfaces it so the client
    // can render the right webhook setup UI.
    const initial = await request.get('/api/config').expect(200);
    expect(typeof initial.body.lanMode).toBe('boolean');

    await request.patch('/api/config').send({ lanMode: true }).expect(200);
    expect(readFileConfig().lanMode).toBe(true);
    const after = await request.get('/api/config').expect(200);
    expect(after.body.lanMode).toBe(true);

    await request.patch('/api/config').send({ lanMode: false }).expect(200);
    expect(readFileConfig().lanMode).toBe(false);
  });

  it('persists openaiApiKey, masks responses, and exposes configured status', async () => {
    await request.patch('/api/config').send({ openaiApiKey: ' sk-openai-test ' }).expect(200);

    expect(readFileConfig().openaiApiKey).toBe('sk-openai-test');
    const configured = await request.get('/api/config').expect(200);
    expect(configured.body.openaiApiKey).toBe('••••••••');
    expect(configured.body.openaiApiKeySet).toBe(true);

    const cleared = await request.patch('/api/config').send({ openaiApiKey: '' }).expect(200);
    expect(cleared.body.updated).toEqual({ openaiApiKey: null });
    expect(readFileConfig().openaiApiKey).toBeNull();

    const afterClear = await request.get('/api/config').expect(200);
    expect(afterClear.body.openaiApiKey).toBe('');
    expect(afterClear.body.openaiApiKeySet).toBe(false);
  });

  it('uses the saved openaiApiKey for the already-mounted transcription route', async () => {
    await request.patch('/api/config').send({ openaiApiKey: 'sk-openai-live' }).expect(200);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello from saved key' }),
      headers: new Headers(),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    try {
      const res = await request
        .post('/api/transcribe')
        .set('content-type', 'audio/webm')
        .send(Buffer.from('fake-audio'))
        .expect(200);

      expect(res.body.transcript).toBe('hello from saved key');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/transcriptions',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer sk-openai-live' },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      await request.patch('/api/config').send({ openaiApiKey: '' }).expect(200);
    }
  });

  it('persists transcriptionProvider and exposes it (plus key status) on GET', async () => {
    // Defaults to 'openai'; the settings page surfaces it so the selector can
    // render the current choice.
    const initial = await request.get('/api/config').expect(200);
    expect(['openai', 'gemini']).toContain(initial.body.transcriptionProvider);
    expect(typeof initial.body.geminiApiKeySet).toBe('boolean');

    const saved = await request
      .patch('/api/config')
      .send({ transcriptionProvider: 'gemini' })
      .expect(200);
    expect(saved.body.updated).toEqual({ transcriptionProvider: 'gemini' });
    expect(readFileConfig().transcriptionProvider).toBe('gemini');

    const after = await request.get('/api/config').expect(200);
    expect(after.body.transcriptionProvider).toBe('gemini');

    // Reset to the default so other tests aren't affected.
    await request.patch('/api/config').send({ transcriptionProvider: 'openai' }).expect(200);
  });

  it('normalizes transcriptionProvider casing/whitespace', async () => {
    const res = await request
      .patch('/api/config')
      .send({ transcriptionProvider: '  GEMINI  ' })
      .expect(200);
    expect(res.body.updated).toEqual({ transcriptionProvider: 'gemini' });
    await request.patch('/api/config').send({ transcriptionProvider: 'openai' }).expect(200);
  });

  it('rejects an invalid transcriptionProvider with 400', async () => {
    const res = await request
      .patch('/api/config')
      .send({ transcriptionProvider: 'deepgram' })
      .expect(400);
    expect(res.body.error).toMatch(/Invalid transcriptionProvider/i);
    expect(res.body.accepted).toEqual(['openai', 'gemini']);
  });

  it('still rejects updates with no allowlisted fields', async () => {
    const res = await request.patch('/api/config').send({ madeUpField: 'nope' }).expect(400);
    expect(res.body.error).toMatch(/No valid config fields/);
  });
});
