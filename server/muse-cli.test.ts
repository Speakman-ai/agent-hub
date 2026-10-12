import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyMuseSpawnEnv,
  buildMuseExecArgs,
  computeMuseUiStatus,
  detectMuseAuthMode,
  extractMuseDeviceUrl,
  extractMuseDeviceUserCode,
  homeHasMuseCredential,
  resolveMuseReasoningEffort,
  resolveMuseSpawnModel,
} from './muse-cli.js';

// Banner printed by `muse login` (muse 1.4.6) when stderr is not a TTY.
const LOGIN_BANNER = [
  'Open this page to sign in:',
  '  https://auth.meta.com/oauth/device/?code=WXYZ-1234',
  'Confirm this code matches:',
  '  WXYZ-1234',
  '',
  'Waiting for approval…',
].join('\n');

describe('buildMuseExecArgs', () => {
  const base = { museSessionId: 'sess-1', promptFile: '/tmp/p.md', model: 'muse-spark-1.3' };

  it('builds a headless JSON run that bypasses approvals outside Ask Mode', () => {
    expect(buildMuseExecArgs({ ...base, askMode: false })).toEqual([
      'exec',
      '--json',
      '--session-id',
      'sess-1',
      '--prompt-file',
      '/tmp/p.md',
      '--reasoning-effort',
      'high',
      '--user-input-auto-resolve',
      '--model',
      'muse-spark-1.3',
      '--yolo',
    ]);
  });

  it('removes the shell and write tools in Ask Mode and never passes --yolo', () => {
    const args = buildMuseExecArgs({ ...base, askMode: true });
    expect(args).toEqual(
      expect.arrayContaining(['--trust-workspace', '--disable-write', '--disable-shell']),
    );
    expect(args).not.toContain('--yolo');
  });

  it('omits --model when no model resolves and maps the pro preset to xhigh', () => {
    const args = buildMuseExecArgs({
      ...base,
      model: null,
      reasoningPreset: 'pro',
      askMode: false,
    });
    expect(args).not.toContain('--model');
    expect(args[args.indexOf('--reasoning-effort') + 1]).toBe('xhigh');
  });
});

describe('resolveMuseSpawnModel / resolveMuseReasoningEffort', () => {
  const cfg = {
    engineValidModels: { 'muse-code': ['muse-spark-1.3', 'muse-spark-1.2'] },
    engineDefaultModels: { 'muse-code': 'muse-spark-1.3' },
  };

  it('passes an allowed model through and replaces an unknown one with the default', () => {
    expect(resolveMuseSpawnModel('muse-spark-1.2', cfg)).toBe('muse-spark-1.2');
    expect(resolveMuseSpawnModel('claude-opus-5-5', cfg)).toBe('muse-spark-1.3');
    expect(resolveMuseSpawnModel(null, cfg)).toBe('muse-spark-1.3');
  });

  it('defaults unknown presets to high', () => {
    expect(resolveMuseReasoningEffort(null)).toBe('high');
    expect(resolveMuseReasoningEffort('bogus')).toBe('high');
    expect(resolveMuseReasoningEffort('pro')).toBe('xhigh');
  });
});

describe('applyMuseSpawnEnv', () => {
  it('strips host credentials and XDG overrides and disables self-update', () => {
    const env: NodeJS.ProcessEnv = {
      META_API_KEY: 'host-key',
      MUSE_AUTH_PATH: '/host/auth.json',
      XDG_CONFIG_HOME: '/host/.config',
      XDG_DATA_HOME: '/host/.local/share',
      HOME: '/data/per-user/u1/home',
    };
    applyMuseSpawnEnv(env);
    expect(env).toEqual({ HOME: '/data/per-user/u1/home', MUSE_NO_AUTO_UPDATE: '1' });
  });
});

describe('muse login banner parsing', () => {
  it('extracts the Meta verification URL and the device code', () => {
    expect(extractMuseDeviceUrl(LOGIN_BANNER)).toBe(
      'https://auth.meta.com/oauth/device/?code=WXYZ-1234',
    );
    expect(extractMuseDeviceUserCode(LOGIN_BANNER)).toBe('WXYZ-1234');
  });

  it('returns null until the banner arrives and rejects look-alike hosts', () => {
    expect(extractMuseDeviceUrl('Waiting…')).toBeNull();
    expect(extractMuseDeviceUserCode('Waiting…')).toBeNull();
    expect(extractMuseDeviceUrl('Open https://auth.meta.com.evil.example/device')).toBeNull();
  });

  it('reads the code from the URL when the label line is missing', () => {
    expect(
      extractMuseDeviceUserCode('go to https://auth.meta.com/oauth/device/?code=abcd-9876'),
    ).toBe('ABCD-9876');
  });
});

describe('detectMuseAuthMode', () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function writeAuth(body: unknown): void {
    mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });
    writeFileSync(path.join(home, '.config', 'muse', 'auth.json'), JSON.stringify(body));
  }

  it('reports oauth, apikey, and missing caches', () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'muse-auth-'));
    expect(homeHasMuseCredential(home)).toBe(false);

    writeAuth({ providers: { meta: { mechanism: 'oauth', access_token: 'tok', expires_at: 1 } } });
    expect(detectMuseAuthMode(home).mode).toBe('oauth');
    expect(homeHasMuseCredential(home)).toBe(true);

    writeAuth({ schema_version: 1, providers: { meta: { api_key: 'k' } } });
    expect(detectMuseAuthMode(home).mode).toBe('apikey');

    // `muse logout` leaves the file with no Meta credential in it.
    writeAuth({ schema_version: 1, providers: {} });
    expect(homeHasMuseCredential(home)).toBe(false);
  });

  it('treats a malformed file as absent', () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'muse-auth-'));
    mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });
    writeFileSync(path.join(home, '.config', 'muse', 'auth.json'), '{nope');
    expect(detectMuseAuthMode(home)).toMatchObject({ mode: 'unknown', present: false });
  });
});

describe('computeMuseUiStatus', () => {
  it('collapses to the shared three-state enum', () => {
    const s = (binaryPresent: boolean, loginInProgress: boolean, credentialPresent: boolean) =>
      computeMuseUiStatus({ binaryPresent, loginInProgress, credentialPresent });
    expect(s(false, true, true)).toBe('missing');
    expect(s(true, true, false)).toBe('pending');
    expect(s(true, false, true)).toBe('authenticated');
    expect(s(true, false, false)).toBe('missing');
  });
});
