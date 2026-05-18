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

  it('still rejects updates with no allowlisted fields', async () => {
    const res = await request.patch('/api/config').send({ madeUpField: 'nope' }).expect(400);
    expect(res.body.error).toMatch(/No valid config fields/);
  });
});
