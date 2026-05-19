import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync } from 'fs';
import path from 'path';

// engine-auth-status reads `~/.claude/.credentials.json` and shells out via
// detectCodexAuthMode / probeCursorStatus. Point HOME at a tmp dir so the
// host's real OAuth file can't leak in, and pass an inline cursorProbe so
// we never spawn `cursor-agent`.
let TMP_DIR = '';
let HOME_DIR = '';

vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { setAuthFilePathForTests, reloadAuthRecord } = await import('./auth-store.js');
const { createUser } = await import('./users-store.js');
const { ensurePerUserHome } = await import('./per-user-home.js');
const { _resetCursorAuthCacheForTests } = await import('./cursor-auth-cache.js');
const { getEngineAuthStatus } = await import('./engine-auth-status.js');

function freshSandbox() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'engine-auth-test-'));
  HOME_DIR = mkdtempSync(path.join(tmpdir(), 'engine-auth-home-'));
  mkdirSync(TMP_DIR, { recursive: true });
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  reloadAuthRecord();
  initOrgsDb();
  process.env.HOME = HOME_DIR;
  process.env.CODEX_HOME = path.join(HOME_DIR, '.codex'); // empty → no codex auth
  _resetCursorAuthCacheForTests();
  // Strip env-based credentials so each case sees a clean slate.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CODEX_API_KEY;
  delete process.env.OPENAI_API_KEY;
}

const noCursor = async () => false;
const withCursor = async () => true;

describe('getEngineAuthStatus', () => {
  beforeEach(() => {
    freshSandbox();
  });

  it('returns any=false when nothing is configured', async () => {
    const out = await getEngineAuthStatus({
      config: {},
      cursorBin: '/nonexistent/cursor-agent',
      cursorProbe: noCursor,
    });
    expect(out).toEqual({ claude: false, cursor: false, codex: false, any: false });
  });

  it('detects host-level Anthropic API key', async () => {
    const out = await getEngineAuthStatus({
      config: { anthropicApiKey: 'sk-ant-test' },
      cursorBin: '/nonexistent/cursor-agent',
      cursorProbe: noCursor,
    });
    expect(out.claude).toBe(true);
    expect(out.any).toBe(true);
  });

  it('detects per-user Claude credentials when host fallback is empty', async () => {
    const user = createUser({
      username: 'creds-test-user',
      passwordHash: 'x',
    });
    // Backdoor: write a Claude key directly via the store (createUser leaves
    // claude fields null).
    const { setUserClaudeAuth } = await import('./users-store.js');
    setUserClaudeAuth(user.id, { anthropicApiKey: 'sk-ant-user' });

    const out = await getEngineAuthStatus({
      config: {},
      cursorBin: '/nonexistent/cursor-agent',
      userId: user.id,
      cursorProbe: noCursor,
    });
    expect(out.claude).toBe(true);
    expect(out.any).toBe(true);
  });

  it('does not consult per-user creds when userId is omitted', async () => {
    const user = createUser({
      username: 'creds-isolated-user',
      passwordHash: 'x',
    });
    const { setUserClaudeAuth } = await import('./users-store.js');
    setUserClaudeAuth(user.id, { anthropicApiKey: 'sk-ant-user' });

    const out = await getEngineAuthStatus({
      config: {},
      cursorBin: '/nonexistent/cursor-agent',
      cursorProbe: noCursor,
    });
    expect(out.claude).toBe(false);
    expect(out.any).toBe(false);
  });

  it('flags cursor=true when the cursor probe returns true', async () => {
    const out = await getEngineAuthStatus({
      config: {},
      cursorBin: '/nonexistent/cursor-agent',
      cursorProbe: withCursor,
    });
    expect(out.cursor).toBe(true);
    expect(out.any).toBe(true);
  });

  it('detects per-user Cursor credentials when host probe is false', async () => {
    const user = createUser({
      username: 'cursor-per-user',
      passwordHash: 'x',
    });
    const { setUserCursorAuth } = await import('./users-store.js');
    setUserCursorAuth(user.id, { apiKey: 'cur-user-key' });

    const out = await getEngineAuthStatus({
      config: {},
      cursorBin: '/nonexistent/cursor-agent',
      userId: user.id,
      cursorProbe: noCursor,
    });
    expect(out.cursor).toBe(true);
    expect(out.any).toBe(true);
  });

  it('does not consult per-user Cursor creds when userId is omitted', async () => {
    const user = createUser({
      username: 'cursor-isolated',
      passwordHash: 'x',
    });
    const { setUserCursorAuth } = await import('./users-store.js');
    setUserCursorAuth(user.id, { apiKey: 'cur-user-key' });

    const out = await getEngineAuthStatus({
      config: {},
      cursorBin: '/nonexistent/cursor-agent',
      cursorProbe: noCursor,
    });
    expect(out.cursor).toBe(false);
    expect(out.any).toBe(false);
  });

  it('JWT callers probe Cursor against per-user HOME only (no host fallback)', async () => {
    const user = createUser({
      username: 'cursor-per-home-only',
      passwordHash: 'x',
    });
    const expectedHome = ensurePerUserHome(user.id, TMP_DIR);
    const perProbe = vi.fn().mockResolvedValue(true);
    const hostProbe = vi.fn().mockResolvedValue(false);

    const out = await getEngineAuthStatus({
      config: {},
      cursorBin: '/bin/agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbe: hostProbe,
      cursorProbePerUserHome: perProbe,
    });

    expect(out.cursor).toBe(true);
    expect(perProbe).toHaveBeenCalledWith('/bin/agent', expectedHome);
    expect(hostProbe).not.toHaveBeenCalled();
  });

  it('JWT callers ignore host Cursor login when per-user HOME reports logged out', async () => {
    const user = createUser({
      username: 'cursor-no-host-fallback',
      passwordHash: 'x',
    });
    const perProbe = vi.fn().mockResolvedValue(false);
    const hostProbe = vi.fn().mockResolvedValue(true);

    const out = await getEngineAuthStatus({
      config: {},
      cursorBin: '/bin/agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbe: hostProbe,
      cursorProbePerUserHome: perProbe,
    });

    expect(out.cursor).toBe(false);
    expect(hostProbe).not.toHaveBeenCalled();
  });

  it('detects codex via CODEX_API_KEY env var', async () => {
    process.env.CODEX_API_KEY = 'codex-test';
    const out = await getEngineAuthStatus({
      config: {},
      cursorBin: '/nonexistent/cursor-agent',
      cursorProbe: noCursor,
    });
    expect(out.codex).toBe(true);
    expect(out.any).toBe(true);
  });

  it('detects per-user Codex API key without host fallback', async () => {
    const user = createUser({
      username: 'codex-per-user',
      passwordHash: 'x',
    });
    const { setUserCodexAuth } = await import('./users-store.js');
    setUserCodexAuth(user.id, { apiKey: 'sk-codex-user' });

    const out = await getEngineAuthStatus({
      config: { codexApiKey: 'sk-codex-host' },
      cursorBin: '/nonexistent/cursor-agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbe: noCursor,
    });
    expect(out.codex).toBe(true);
  });

  it('JWT callers ignore host Codex login when per-user cache is empty', async () => {
    const user = createUser({
      username: 'codex-no-host-fallback',
      passwordHash: 'x',
    });
    process.env.CODEX_API_KEY = 'codex-host-only';
    const out = await getEngineAuthStatus({
      config: { codexApiKey: 'sk-codex-host' },
      cursorBin: '/nonexistent/cursor-agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbe: noCursor,
    });
    expect(out.codex).toBe(false);
  });
});
