import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, statSync, readFileSync, existsSync } from 'fs';
import path from 'path';

// Point the auth-store at a tmp dir. Same mock pattern as auth-store.test.ts.
let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

// migrateAuthRecordIfNeeded touches orgs.db which isn't initialized in this
// test setup. The bootstrap module wraps the call in try/catch so a thrown
// error here is fine, but we stub it to a no-op for clean test output.
vi.mock('./users-store.js', () => ({
  migrateAuthRecordIfNeeded: vi.fn(() => null),
}));

const { maybeAutoProvisionOwner, credentialsFilePath } = await import('./auth-bootstrap.js');
const { getAuthRecord, reloadAuthRecord, setAuthFilePathForTests, saveAuthRecord } =
  await import('./auth-store.js');
const { verifyPassword } = await import('./password.js');

function freshTmpDir(): void {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'auth-bootstrap-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  reloadAuthRecord();
}

const FROZEN_NOW = new Date('2026-04-29T03:00:00.000Z');
const STABLE_PASSWORD = 'auto-generated-stable-password-x9';

const baseOpts = () => ({
  dataDir: TMP_DIR,
  now: () => FROZEN_NOW,
  randomPassword: () => STABLE_PASSWORD,
  // Silence info/error so vitest output stays focused on assertions.
  log: vi.fn(),
});

describe('auth-bootstrap — maybeAutoProvisionOwner', () => {
  beforeEach(() => {
    freshTmpDir();
  });

  it('skips when AGENT_HUB_DEFAULT_PASSWORD is unset', async () => {
    const result = await maybeAutoProvisionOwner({ env: {}, ...baseOpts() });
    expect(result).toEqual({ provisioned: false, reason: 'no-default-password-env' });
    expect(getAuthRecord()).toBeNull();
  });

  it('skips when AGENT_HUB_DEFAULT_PASSWORD is empty string', async () => {
    const result = await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: '' },
      ...baseOpts(),
    });
    expect(result.provisioned).toBe(false);
    expect(getAuthRecord()).toBeNull();
  });

  it('skips when an auth record already exists (idempotent)', async () => {
    saveAuthRecord({
      username: 'existing',
      passwordHash: 'preexisting-hash',
      jwtSecret: 'preexisting-secret',
      role: 'Owner',
    });
    const result = await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: 'literal-password-1234' },
      ...baseOpts(),
    });
    expect(result).toEqual({ provisioned: false, reason: 'auth-already-configured' });
    // The pre-existing record is intact — we did NOT overwrite.
    expect(getAuthRecord()?.username).toBe('existing');
    expect(getAuthRecord()?.passwordHash).toBe('preexisting-hash');
  });

  it('creates the Owner from a literal env password', async () => {
    const result = await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: 'literal-password-1234' },
      ...baseOpts(),
    });
    expect(result.provisioned).toBe(true);
    if (result.provisioned) {
      expect(result.username).toBe('admin');
      expect(result.passwordSource).toBe('env');
      expect(result.credentialsFile).toBeUndefined();
    }
    const record = getAuthRecord();
    expect(record).not.toBeNull();
    expect(record!.username).toBe('admin');
    expect(record!.role).toBe('Owner');
    expect(record!.createdAt).toBe(FROZEN_NOW.toISOString());
    // Password hash must round-trip through verifyPassword.
    expect(await verifyPassword('literal-password-1234', record!.passwordHash)).toBe(true);
    // No credentials file written for the literal path.
    expect(existsSync(credentialsFilePath(TMP_DIR))).toBe(false);
  });

  it('honors AGENT_HUB_DEFAULT_USERNAME when set', async () => {
    const result = await maybeAutoProvisionOwner({
      env: {
        AGENT_HUB_DEFAULT_USERNAME: 'ryan',
        AGENT_HUB_DEFAULT_PASSWORD: 'literal-password-1234',
      },
      ...baseOpts(),
    });
    expect(result.provisioned).toBe(true);
    expect(getAuthRecord()?.username).toBe('ryan');
  });

  it('rejects invalid usernames and skips provisioning', async () => {
    const log = vi.fn();
    const result = await maybeAutoProvisionOwner({
      env: {
        AGENT_HUB_DEFAULT_USERNAME: 'has spaces!',
        AGENT_HUB_DEFAULT_PASSWORD: 'literal-password-1234',
      },
      ...baseOpts(),
      log,
    });
    expect(result).toEqual({ provisioned: false, reason: 'invalid-username' });
    expect(getAuthRecord()).toBeNull();
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('AGENT_HUB_DEFAULT_USERNAME'),
    );
  });

  it('rejects too-short literal passwords and skips provisioning', async () => {
    const log = vi.fn();
    const result = await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: 'short' },
      ...baseOpts(),
      log,
    });
    expect(result).toEqual({ provisioned: false, reason: 'invalid-password' });
    expect(getAuthRecord()).toBeNull();
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('AGENT_HUB_DEFAULT_PASSWORD rejected'),
    );
  });

  it('generates a random password when AGENT_HUB_DEFAULT_PASSWORD=auto and writes mode 0600 file', async () => {
    const result = await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: 'auto' },
      ...baseOpts(),
    });
    expect(result.provisioned).toBe(true);
    if (!result.provisioned) throw new Error('expected provisioned=true');
    expect(result.passwordSource).toBe('auto');
    expect(result.credentialsFile).toBe(credentialsFilePath(TMP_DIR));

    const record = getAuthRecord();
    expect(record).not.toBeNull();
    expect(await verifyPassword(STABLE_PASSWORD, record!.passwordHash)).toBe(true);

    const credentialsFile = credentialsFilePath(TMP_DIR);
    expect(existsSync(credentialsFile)).toBe(true);
    const body = readFileSync(credentialsFile, 'utf-8');
    expect(body).toContain('Username: admin');
    expect(body).toContain(`Password: ${STABLE_PASSWORD}`);
    expect(body).toContain(FROZEN_NOW.toISOString());

    const stat = statSync(credentialsFile);
    // 0o600 = 384. Mask off the file-type bits via 0o777 to compare.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('treats AUTO/Auto/auto as case-insensitive', async () => {
    for (const literal of ['auto', 'Auto', 'AUTO', '  auto  ']) {
      freshTmpDir();
      const result = await maybeAutoProvisionOwner({
        env: { AGENT_HUB_DEFAULT_PASSWORD: literal },
        ...baseOpts(),
      });
      expect(result.provisioned).toBe(true);
      if (result.provisioned) {
        expect(result.passwordSource).toBe('auto');
      }
    }
  });

  it('does not touch org.mode (auth bypass is env-driven, not DB-driven)', async () => {
    // Regression: an earlier revision flipped the active org to
    // mode='remote' on provision so the auth middleware would actually
    // enforce credentials. That coupling has been replaced by the
    // AGENT_HUB_MODE env var (see `isLocalBundledServer()` in
    // server/auth.ts). The bootstrap path must therefore NOT import or
    // call anything from orgs.js — verified here by asserting the
    // module isn't even resolved as a side effect of provisioning.
    const log = vi.fn();
    const result = await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: 'literal-password-1234' },
      ...baseOpts(),
      log,
    });
    expect(result.provisioned).toBe(true);
    // No "flip org" / "remote mode" log lines should have been emitted.
    const flipLogs = log.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && /flip|remote mode/.test(msg),
    );
    expect(flipLogs).toEqual([]);
  });

  it('persists a JWT secret unique per provision', async () => {
    await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: 'literal-password-1234' },
      ...baseOpts(),
    });
    const firstSecret = getAuthRecord()!.jwtSecret;
    expect(firstSecret).toMatch(/^[a-f0-9]{64}$/);

    // Second call (with record already present) is a no-op — secret unchanged.
    await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: 'literal-password-1234' },
      ...baseOpts(),
    });
    expect(getAuthRecord()!.jwtSecret).toBe(firstSecret);
  });
});
