/**
 * Integration tests for GET /api/config/models — auth-aware engine maps,
 * `engineAuth` contract, and Cursor status via a fixture binary (no real CLI).
 */
import type TestAgent from 'supertest/lib/agent.js';
import { writeFileSync, chmodSync, unlinkSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { getRequest } from '../test/helpers.js';

let request: TestAgent;
let savedCursorBin: string;

function writeCursorFixture(name: string, authenticated: boolean): string {
  const p = path.join(os.tmpdir(), `${name}-${process.pid}.mjs`);
  const body = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('status') && argv.includes('--format') && argv.includes('json')) {
  console.log(JSON.stringify({ isAuthenticated: ${authenticated ? 'true' : 'false'} }));
}
`;
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

beforeAll(async () => {
  request = await getRequest();
  const cfg = await request.get('/api/config').expect(200);
  savedCursorBin = cfg.body.cursorBin as string;
}, 60_000);

afterAll(async () => {
  if (savedCursorBin && request) {
    await request.patch('/api/config').send({ cursorBin: savedCursorBin });
  }
});

describe('GET /api/config/models — authenticated engine contract', () => {
  it('returns engineAuth booleans and engineValidModels keyed by engine', async () => {
    const res = await request.get('/api/config/models').expect(200);
    const body = res.body as {
      defaultModel: string;
      engineAuth: Record<string, boolean>;
      engineValidModels: Record<string, string[]>;
      engineDefaultModels: Record<string, string>;
    };
    // engineAuth still reports gemini presence (drives RAG-configured status),
    // even though gemini-cli is never a selectable picker engine.
    expect(body.engineAuth).toEqual(
      expect.objectContaining({
        'claude-code': expect.any(Boolean),
        'cursor-agent': expect.any(Boolean),
        'gemini-cli': expect.any(Boolean),
        'codex-cli': expect.any(Boolean),
        'grok-cli': expect.any(Boolean),
      }),
    );
    // Selectable engines carry a model array; gemini-cli is RAG-only and must
    // NOT appear in the picker feed at all (not even as an empty list).
    for (const engine of ['claude-code', 'cursor-agent', 'codex-cli', 'grok-cli']) {
      expect(Array.isArray(body.engineValidModels[engine])).toBe(true);
    }
    expect(body.engineValidModels).not.toHaveProperty('gemini-cli');
    expect(body.engineDefaultModels).not.toHaveProperty('gemini-cli');
    expect(typeof body.defaultModel).toBe('string');
  });

  it('does NOT grant cursor-agent auth from a host CLI login when the caller has no per-account identity', async () => {
    // Per-account contract: Cursor auth is resolved ONLY from the
    // requesting user's stored key / per-user HOME OAuth. A host-level
    // `cursor-agent login` (the fixture reports authenticated) must NOT
    // flip engineAuth for an unauthenticated caller — there is no host
    // fallback. The integration harness has no per-user JWT, so even an
    // "authenticated" host binary leaves cursor-agent false + no models.
    const fixture = writeCursorFixture('cursor-status-ok', true);
    try {
      await request.patch('/api/config').send({ cursorBin: fixture }).expect(200);
      const res = await request.get('/api/config/models').expect(200);
      const body = res.body as {
        engineAuth: { 'cursor-agent': boolean };
        engineValidModels: { 'cursor-agent': string[] };
      };
      expect(body.engineAuth['cursor-agent']).toBe(false);
      expect(body.engineValidModels['cursor-agent']).toEqual([]);
    } finally {
      if (existsSync(fixture)) unlinkSync(fixture);
    }
  });

  it('treats fixture cursor as logged out — empty cursor-agent model list', async () => {
    const fixture = writeCursorFixture('cursor-status-bad', false);
    try {
      await request.patch('/api/config').send({ cursorBin: fixture }).expect(200);
      const res = await request.get('/api/config/models').expect(200);
      const body = res.body as {
        engineAuth: { 'cursor-agent': boolean };
        engineValidModels: { 'cursor-agent': string[] };
        engineDefaultModels: { 'cursor-agent': string };
      };
      expect(body.engineAuth['cursor-agent']).toBe(false);
      expect(body.engineValidModels['cursor-agent']).toEqual([]);
      expect(body.engineDefaultModels['cursor-agent']).toBe('');
    } finally {
      if (existsSync(fixture)) unlinkSync(fixture);
    }
  });

  it('reports claude-code / codex-cli unavailable for an unauthenticated caller (per-account, no host fallback)', async () => {
    // The global host-level Claude/Codex auth endpoints were removed —
    // these engines authenticate strictly per-account. With no per-user
    // identity on the request, the models map must report them
    // unavailable with empty model lists regardless of any host env.
    const res = await request.get('/api/config/models').expect(200);
    const body = res.body as {
      engineAuth: Record<string, boolean>;
      engineValidModels: Record<string, string[]>;
    };
    expect(body.engineAuth['claude-code']).toBe(false);
    expect(body.engineValidModels['claude-code']).toEqual([]);
    expect(body.engineAuth['codex-cli']).toBe(false);
    expect(body.engineValidModels['codex-cli']).toEqual([]);
  });
});
