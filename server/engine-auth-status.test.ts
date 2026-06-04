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

describe('getEngineAuthStatus — strictly per-account (no host fallback)', () => {
  beforeEach(() => {
    freshSandbox();
  });

  it('returns all-false when no userId is supplied (no host fallback)', async () => {
    const out = await getEngineAuthStatus({
      cursorBin: '/nonexistent/cursor-agent',
      cursorProbePerUserHome: noCursor,
    });
    expect(out).toEqual({ claude: false, cursor: false, codex: false, any: false });
  });

  it('returns all-false for a known user with no stored credentials', async () => {
    const user = createUser({ username: 'empty-user', passwordHash: 'x' });
    const out = await getEngineAuthStatus({
      cursorBin: '/nonexistent/cursor-agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbePerUserHome: noCursor,
    });
    expect(out).toEqual({ claude: false, cursor: false, codex: false, any: false });
  });

  it('detects per-user Claude credentials', async () => {
    const user = createUser({
      username: 'creds-test-user',
      passwordHash: 'x',
    });
    const { setUserClaudeAuth } = await import('./users-store.js');
    setUserClaudeAuth(user.id, { anthropicApiKey: 'sk-ant-user' });

    const out = await getEngineAuthStatus({
      cursorBin: '/nonexistent/cursor-agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbePerUserHome: noCursor,
    });
    expect(out.claude).toBe(true);
    expect(out.any).toBe(true);
  });

  it('does not consult per-user Claude creds when userId is omitted', async () => {
    const user = createUser({
      username: 'creds-isolated-user',
      passwordHash: 'x',
    });
    const { setUserClaudeAuth } = await import('./users-store.js');
    setUserClaudeAuth(user.id, { anthropicApiKey: 'sk-ant-user' });

    const out = await getEngineAuthStatus({
      cursorBin: '/nonexistent/cursor-agent',
      cursorProbePerUserHome: noCursor,
    });
    expect(out.claude).toBe(false);
    expect(out.any).toBe(false);
  });

  it('flags cursor=true when the per-user HOME probe returns true', async () => {
    const user = createUser({ username: 'cursor-probe-user', passwordHash: 'x' });
    const out = await getEngineAuthStatus({
      cursorBin: '/bin/agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbePerUserHome: withCursor,
    });
    expect(out.cursor).toBe(true);
    expect(out.any).toBe(true);
  });

  it('detects per-user Cursor API key (short-circuits the probe)', async () => {
    const user = createUser({
      username: 'cursor-per-user',
      passwordHash: 'x',
    });
    const { setUserCursorAuth } = await import('./users-store.js');
    setUserCursorAuth(user.id, { apiKey: 'cur-user-key' });

    const out = await getEngineAuthStatus({
      cursorBin: '/nonexistent/cursor-agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbePerUserHome: noCursor,
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
      cursorBin: '/nonexistent/cursor-agent',
      cursorProbePerUserHome: noCursor,
    });
    expect(out.cursor).toBe(false);
    expect(out.any).toBe(false);
  });

  it('probes Cursor against the per-user HOME', async () => {
    const user = createUser({
      username: 'cursor-per-home-only',
      passwordHash: 'x',
    });
    const expectedHome = ensurePerUserHome(user.id, TMP_DIR);
    const perProbe = vi.fn().mockResolvedValue(true);

    const out = await getEngineAuthStatus({
      cursorBin: '/bin/agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbePerUserHome: perProbe,
    });

    expect(out.cursor).toBe(true);
    expect(perProbe).toHaveBeenCalledWith('/bin/agent', expectedHome);
  });

  it('reports cursor=false when the per-user HOME probe reports logged out', async () => {
    const user = createUser({
      username: 'cursor-no-host-fallback',
      passwordHash: 'x',
    });
    const perProbe = vi.fn().mockResolvedValue(false);

    const out = await getEngineAuthStatus({
      cursorBin: '/bin/agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbePerUserHome: perProbe,
    });

    expect(out.cursor).toBe(false);
  });

  it('detects per-user Codex API key', async () => {
    const user = createUser({
      username: 'codex-per-user',
      passwordHash: 'x',
    });
    const { setUserCodexAuth } = await import('./users-store.js');
    setUserCodexAuth(user.id, { apiKey: 'sk-codex-user' });

    const out = await getEngineAuthStatus({
      cursorBin: '/nonexistent/cursor-agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbePerUserHome: noCursor,
    });
    expect(out.codex).toBe(true);
  });

  it('ignores a host-process CODEX_API_KEY when the per-user cache is empty', async () => {
    const user = createUser({
      username: 'codex-no-host-fallback',
      passwordHash: 'x',
    });
    process.env.CODEX_API_KEY = 'codex-host-only';
    const out = await getEngineAuthStatus({
      cursorBin: '/nonexistent/cursor-agent',
      userId: user.id,
      dataDir: TMP_DIR,
      cursorProbePerUserHome: noCursor,
    });
    expect(out.codex).toBe(false);
  });
});
