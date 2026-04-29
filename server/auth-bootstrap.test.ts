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

// orgs.db is similarly not initialized; we stub updateOrg / getActiveOrgId
// so we can observe calls without needing the real sqlite layer. The
// `default` org id is what the real code seeds at startup.
const updateOrgMock = vi.fn(
  (_orgId: string, _opts: { mode?: string }): { org_id: string; mode: string } | null => ({
    org_id: 'default',
    mode: 'remote',
  }),
);
const getActiveOrgIdMock = vi.fn((): string => 'default');
vi.mock('./orgs.js', () => ({
  updateOrg: (orgId: string, opts: { mode?: string }) => updateOrgMock(orgId, opts),
  getActiveOrgId: () => getActiveOrgIdMock(),
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
    updateOrgMock.mockClear();
    getActiveOrgIdMock.mockClear();
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

  it("flips the active org to mode='remote' on successful provision", async () => {
    const result = await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: 'literal-password-1234' },
      ...baseOpts(),
    });
    expect(result.provisioned).toBe(true);
    expect(getActiveOrgIdMock).toHaveBeenCalled();
    expect(updateOrgMock).toHaveBeenCalledWith('default', { mode: 'remote' });
  });

  it('does NOT flip org mode when provisioning is skipped', async () => {
    // Skip path: missing env. Org mode must NOT be touched, otherwise we'd
    // forcibly disable local-bypass on every cold boot.
    await maybeAutoProvisionOwner({ env: {}, ...baseOpts() });
    expect(updateOrgMock).not.toHaveBeenCalled();

    // Skip path: auth already configured. Same expectation.
    saveAuthRecord({
      username: 'existing',
      passwordHash: 'preexisting-hash',
      jwtSecret: 'preexisting-secret',
      role: 'Owner',
    });
    await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: 'literal-password-1234' },
      ...baseOpts(),
    });
    expect(updateOrgMock).not.toHaveBeenCalled();
  });

  it('logs but does not throw when updateOrg cannot find the org', async () => {
    updateOrgMock.mockReturnValueOnce(null as unknown as { org_id: string; mode: string });
    const log = vi.fn();
    const result = await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: 'literal-password-1234' },
      ...baseOpts(),
      log,
    });
    expect(result.provisioned).toBe(true);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('flip org'));
  });

  it('logs but does not throw when updateOrg itself throws', async () => {
    updateOrgMock.mockImplementationOnce(() => {
      throw new Error('orgs.db not initialized');
    });
    const log = vi.fn();
    const result = await maybeAutoProvisionOwner({
      env: { AGENT_HUB_DEFAULT_PASSWORD: 'literal-password-1234' },
      ...baseOpts(),
      log,
    });
    expect(result.provisioned).toBe(true);
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Failed to flip active org to remote mode'),
    );
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
