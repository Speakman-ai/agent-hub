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
      engineAuth: Record<string, boolean>;
      engineValidModels: Record<string, string[]>;
      engineDefaultModels: Record<string, string>;
      defaultModel: string;
    };
    expect(typeof body.defaultModel).toBe('string');
    expect(body.engineAuth).toEqual(
      expect.objectContaining({
        'claude-code': expect.any(Boolean),
        'cursor-agent': expect.any(Boolean),
        'gemini-cli': expect.any(Boolean),
        'codex-cli': expect.any(Boolean),
      }),
    );
    for (const engine of ['claude-code', 'cursor-agent', 'gemini-cli', 'codex-cli']) {
      expect(Array.isArray(body.engineValidModels[engine])).toBe(true);
    }
  });

  it('uses a fixture cursor binary so cursor-agent auth maps to engineAuth + models', async () => {
    const fixture = writeCursorFixture('cursor-status-ok', true);
    try {
      await request.patch('/api/config').send({ cursorBin: fixture }).expect(200);
      const res = await request.get('/api/config/models').expect(200);
      const body = res.body as {
        engineAuth: { 'cursor-agent': boolean };
        engineValidModels: { 'cursor-agent': string[] };
      };
      expect(body.engineAuth['cursor-agent']).toBe(true);
      expect(body.engineValidModels['cursor-agent'].length).toBeGreaterThan(0);
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

  it('PATCH /api/config { cursorBin } invalidates the cursor-auth cache so the next models call re-probes', async () => {
    // Reviewer's race (PR #842): `getCursorAuthenticatedCached` memoizes for 60s,
    // keyed on the resolved cursor bin path. Without invalidation on a PATCH
    // that touches `cursorBin`, the wizard's post-configure Save & Continue
    // check can keep seeing a stale `false` even after the user has finished
    // `cursor-agent login`. We can't trigger a real OAuth flow in tests, but
    // we can simulate the same auth-state flip by rewriting the fixture
    // binary in place: it always sits at the same path, so the cache key
    // doesn't move — only the probe result changes. The fix invalidates on
    // PATCH regardless of whether the bin string itself changed.
    const fixture = writeCursorFixture('cursor-status-flip', false);
    try {
      await request.patch('/api/config').send({ cursorBin: fixture }).expect(200);
      const beforeLogin = await request.get('/api/config/models').expect(200);
      expect(beforeLogin.body.engineAuth['cursor-agent']).toBe(false);

      // Simulate `cursor-agent login` succeeding: same binary path, but it
      // now reports authenticated. If the cache weren't invalidated by the
      // PATCH below we'd see the stale `false` for up to 60s.
      writeFileSync(
        fixture,
        `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('status') && argv.includes('--format') && argv.includes('json')) {
  console.log(JSON.stringify({ isAuthenticated: true }));
}
`,
        { mode: 0o755 },
      );
      chmodSync(fixture, 0o755);

      // Re-PATCH the same cursorBin path. Without the fix this is a no-op
      // for cache purposes; with the fix it drops the cached entry so the
      // next /api/config/models re-runs the probe.
      await request.patch('/api/config').send({ cursorBin: fixture }).expect(200);

      const afterLogin = await request.get('/api/config/models').expect(200);
      expect(afterLogin.body.engineAuth['cursor-agent']).toBe(true);
      expect(afterLogin.body.engineValidModels['cursor-agent'].length).toBeGreaterThan(0);
    } finally {
      if (existsSync(fixture)) unlinkSync(fixture);
    }
  });

  it('POST /api/setup/configure { cursorBin } invalidates the cursor-auth cache for the next models poll', async () => {
    // Same race as the PATCH test, but driven through the SetupWizard's
    // primary write surface. Step 3 of the wizard hits /setup/configure and
    // then immediately polls /api/config/models — if that poll returns a
    // cached `false` from a pre-login status spawn, Save & Continue
    // refuses to advance even though the wizard's own status probe shows
    // the user authenticated.
    const fixture = writeCursorFixture('cursor-setup-configure-flip', false);
    try {
      await request.post('/api/setup/configure').send({ cursorBin: fixture }).expect(200);
      const before = await request.get('/api/config/models').expect(200);
      expect(before.body.engineAuth['cursor-agent']).toBe(false);

      writeFileSync(
        fixture,
        `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('status') && argv.includes('--format') && argv.includes('json')) {
  console.log(JSON.stringify({ isAuthenticated: true }));
}
`,
        { mode: 0o755 },
      );
      chmodSync(fixture, 0o755);

      await request.post('/api/setup/configure').send({ cursorBin: fixture }).expect(200);

      const after = await request.get('/api/config/models').expect(200);
      expect(after.body.engineAuth['cursor-agent']).toBe(true);
    } finally {
      if (existsSync(fixture)) unlinkSync(fixture);
    }
  });

  it('treats a saved claude setup-token as Claude auth even without API key or CLI OAuth', async () => {
    // Snapshot env so other tests inheriting credentials don't decide this case.
    const savedApiKeyEnv = process.env.ANTHROPIC_API_KEY;
    const savedOauthEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const before = await request.get('/api/config/claude-auth').expect(200);
    const hadApiKey = !!before.body?.apiKey?.configured;
    const hadToken = !!before.body?.oauthToken?.configured;

    // Drop API key + setup token to baseline so the only Claude auth signal we
    // toggle is `claudeCodeOAuthToken`. `hasClaudeOauth()` reads ~/.claude on
    // disk; if a real OAuth login exists in the dev's home dir this assertion
    // flips early — the negative-case skip below covers that.
    await request.post('/api/config/claude-auth/api-key').send({ apiKey: '' }).expect(200);
    await request.post('/api/config/claude-auth/oauth-token').send({ oauthToken: '' }).expect(200);

    const baseline = await request.get('/api/config/models').expect(200);
    const hostHasOtherClaudeAuth = baseline.body.engineAuth['claude-code'] === true;

    try {
      await request
        .post('/api/config/claude-auth/oauth-token')
        .send({ oauthToken: 'sk-ant-oat01-test-fixture' })
        .expect(200);

      const res = await request.get('/api/config/models').expect(200);
      const body = res.body as {
        engineAuth: { 'claude-code': boolean };
        engineValidModels: { 'claude-code': string[] };
      };
      expect(body.engineAuth['claude-code']).toBe(true);
      expect(body.engineValidModels['claude-code'].length).toBeGreaterThan(0);

      if (!hostHasOtherClaudeAuth) {
        // Removing the setup token should now flip Claude back to unauthenticated —
        // proves the setup token (not some unrelated source) is what enabled it.
        await request
          .post('/api/config/claude-auth/oauth-token')
          .send({ oauthToken: '' })
          .expect(200);
        const after = await request.get('/api/config/models').expect(200);
        expect(after.body.engineAuth['claude-code']).toBe(false);
        expect(after.body.engineValidModels['claude-code']).toEqual([]);
      }
    } finally {
      if (!hadToken) {
        await request
          .post('/api/config/claude-auth/oauth-token')
          .send({ oauthToken: '' })
          .catch(() => {});
      }
      if (!hadApiKey) {
        await request
          .post('/api/config/claude-auth/api-key')
          .send({ apiKey: '' })
          .catch(() => {});
      }
      if (savedApiKeyEnv !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKeyEnv;
      if (savedOauthEnv !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthEnv;
    }
  });
});
