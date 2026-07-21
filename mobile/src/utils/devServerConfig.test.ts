import { describe, it, expect } from 'vitest';
import {
  buildDevServerConfig,
  buildSecretsPutPayload,
  buildSecretsSnapshotPayload,
  devServerFormFromProject,
  emptyDevServerForm,
  validateDevServerForm,
  SECRET_MASK,
  DEV_SERVER_DEFAULT_START_COMMAND,
  type DevServerForm,
} from './devServerConfig';

function baseForm(overrides: Partial<DevServerForm> = {}): DevServerForm {
  return { ...emptyDevServerForm(), startCommand: 'npm run dev', ...overrides };
}

describe('devServerFormFromProject', () => {
  it('defaults an empty project to the default start command', () => {
    const form = devServerFormFromProject(null, []);
    expect(form.startCommand).toBe(DEV_SERVER_DEFAULT_START_COMMAND);
    expect(form.envRows).toEqual([]);
    expect(form.secretRows).toEqual([]);
    expect(form.portRows).toEqual([]);
  });

  it('maps a saved devServer config into editable rows', () => {
    const project = {
      prEnv: {
        devServer: {
          startCommand: 'pnpm dev',
          env: { API_URL: 'http://localhost:4000' },
          secretKeys: ['STRIPE_KEY', 'DB_PASSWORD'],
          portMap: [
            { internalPort: 3000, label: 'web', primary: true },
            { internalPort: 4000, label: 'api' },
          ],
          healthPath: '/healthz',
          readyTimeoutMs: 120000,
          cwd: 'apps/web',
        },
      },
    };
    const secrets = [{ key: 'STRIPE_KEY', kind: 'secret' as const }];
    const form = devServerFormFromProject(project, secrets);
    expect(form.startCommand).toBe('pnpm dev');
    expect(form.envRows).toEqual([{ key: 'API_URL', value: 'http://localhost:4000' }]);
    // STRIPE_KEY has a stored secret → hadSecret true; DB_PASSWORD does not.
    expect(form.secretRows).toEqual([
      { key: 'STRIPE_KEY', value: '', hadSecret: true },
      { key: 'DB_PASSWORD', value: '', hadSecret: false },
    ]);
    expect(form.portRows).toEqual([
      { internalPort: '3000', label: 'web', primary: true },
      { internalPort: '4000', label: 'api', primary: false },
    ]);
    expect(form.healthPath).toBe('/healthz');
    expect(form.readyTimeoutMs).toBe('120000');
    expect(form.cwd).toBe('apps/web');
  });

  it('never loads a plaintext secret value into a row (write-only)', () => {
    const project = { prEnv: { devServer: { secretKeys: ['TOKEN'] } } };
    // Even if the API somehow returned a value, the row value stays empty.
    const form = devServerFormFromProject(project, [
      { key: 'TOKEN', kind: 'secret', value: 'super-secret' } as any,
    ]);
    expect(form.secretRows[0].value).toBe('');
    expect(form.secretRows[0].hadSecret).toBe(true);
  });
});

describe('validateDevServerForm', () => {
  it('accepts a valid form', () => {
    const form = baseForm({
      envRows: [{ key: 'FOO', value: 'bar' }],
      secretRows: [{ key: 'SECRET_ONE', value: 'x', hadSecret: false }],
      portRows: [{ internalPort: '3000', label: 'web', primary: true }],
      healthPath: '/health',
      readyTimeoutMs: '60000',
      cwd: 'apps/web',
    });
    expect(validateDevServerForm(form)).toBeNull();
  });

  it('rejects an empty start command', () => {
    expect(validateDevServerForm(baseForm({ startCommand: '   ' }))?.field).toBe('startCommand');
  });

  it('rejects an invalid env key', () => {
    const err = validateDevServerForm(baseForm({ envRows: [{ key: '1BAD', value: 'x' }] }));
    expect(err?.field).toBe('env');
    expect(err?.index).toBe(0);
  });

  it('rejects a reserved env key (PORT is server-injected)', () => {
    const err = validateDevServerForm(baseForm({ envRows: [{ key: 'PORT', value: '3000' }] }));
    expect(err?.field).toBe('env');
    expect(err?.error).toMatch(/reserved/);
  });

  it('rejects a reserved AGENT_HUB_ env key', () => {
    const err = validateDevServerForm(
      baseForm({ envRows: [{ key: 'AGENT_HUB_URL', value: 'x' }] }),
    );
    expect(err?.error).toMatch(/reserved/);
  });

  it('rejects a key present in both env and secretKeys', () => {
    const err = validateDevServerForm(
      baseForm({
        envRows: [{ key: 'SHARED', value: 'x' }],
        secretRows: [{ key: 'SHARED', value: 'y', hadSecret: false }],
      }),
    );
    expect(err?.field).toBe('secretKeys');
    expect(err?.error).toMatch(/both env and secret/);
  });

  it('rejects a duplicate secret key', () => {
    const err = validateDevServerForm(
      baseForm({
        secretRows: [
          { key: 'DUP', value: 'a', hadSecret: false },
          { key: 'DUP', value: 'b', hadSecret: false },
        ],
      }),
    );
    expect(err?.field).toBe('secretKeys');
    expect(err?.error).toMatch(/more than once/);
  });

  it('rejects a new secret reference with a blank value (would dangle in secretKeys)', () => {
    const err = validateDevServerForm(
      baseForm({ secretRows: [{ key: 'NEW_SECRET', value: '   ', hadSecret: false }] }),
    );
    expect(err?.field).toBe('secretKeys');
    expect(err?.index).toBe(0);
    expect(err?.error).toMatch(/Enter a value/);
  });

  it('allows an already-stored secret reference to keep a blank value', () => {
    const err = validateDevServerForm(
      baseForm({ secretRows: [{ key: 'STORED_SECRET', value: '', hadSecret: true }] }),
    );
    expect(err).toBeNull();
  });

  it('rejects an out-of-range internal port', () => {
    const err = validateDevServerForm(
      baseForm({ portRows: [{ internalPort: '70000', label: 'web', primary: false }] }),
    );
    expect(err?.field).toBe('portMap');
  });

  it('rejects a port row missing its label', () => {
    const err = validateDevServerForm(
      baseForm({ portRows: [{ internalPort: '3000', label: '  ', primary: false }] }),
    );
    expect(err?.field).toBe('portMap');
    expect(err?.error).toMatch(/label/);
  });

  it('rejects more than one primary port', () => {
    const err = validateDevServerForm(
      baseForm({
        portRows: [
          { internalPort: '3000', label: 'web', primary: true },
          { internalPort: '4000', label: 'api', primary: true },
        ],
      }),
    );
    expect(err?.field).toBe('portMap');
    expect(err?.error).toMatch(/one port/);
  });

  it('rejects a duplicate internal port', () => {
    const err = validateDevServerForm(
      baseForm({
        portRows: [
          { internalPort: '3000', label: 'web', primary: false },
          { internalPort: '3000', label: 'api', primary: false },
        ],
      }),
    );
    expect(err?.field).toBe('portMap');
  });

  it('rejects a health path that does not start with /', () => {
    expect(validateDevServerForm(baseForm({ healthPath: 'health' }))?.field).toBe('healthPath');
  });

  it('rejects a ready timeout below the minimum', () => {
    expect(validateDevServerForm(baseForm({ readyTimeoutMs: '1000' }))?.field).toBe(
      'readyTimeoutMs',
    );
  });

  it('rejects an absolute cwd', () => {
    expect(validateDevServerForm(baseForm({ cwd: '/etc' }))?.field).toBe('cwd');
  });

  it('rejects a cwd that escapes the worktree', () => {
    expect(validateDevServerForm(baseForm({ cwd: '../outside' }))?.field).toBe('cwd');
  });
});

describe('buildDevServerConfig', () => {
  it('builds a minimal config, omitting empty optionals', () => {
    const cfg = buildDevServerConfig(baseForm({ startCommand: ' npm start ' }));
    expect(cfg).toEqual({ startCommand: 'npm start', env: {}, secretKeys: [], portMap: [] });
    expect(cfg).not.toHaveProperty('healthPath');
    expect(cfg).not.toHaveProperty('readyTimeoutMs');
    expect(cfg).not.toHaveProperty('cwd');
  });

  it('builds a full config with typed ports and optionals', () => {
    const cfg = buildDevServerConfig(
      baseForm({
        startCommand: 'pnpm dev',
        envRows: [
          { key: ' API_URL ', value: 'http://x' },
          { key: '', value: 'dropped' },
        ],
        secretRows: [
          { key: 'STRIPE', value: 'sk_live', hadSecret: false },
          { key: '', value: '', hadSecret: false },
        ],
        portRows: [
          { internalPort: '3000', label: ' web ', primary: true },
          { internalPort: '4000', label: 'api', primary: false },
          { internalPort: '', label: 'ignored', primary: false },
        ],
        healthPath: '/healthz',
        readyTimeoutMs: '90000',
        cwd: 'apps/web',
      }),
    );
    expect(cfg).toEqual({
      startCommand: 'pnpm dev',
      env: { API_URL: 'http://x' },
      secretKeys: ['STRIPE'],
      portMap: [
        { internalPort: 3000, label: 'web', primary: true },
        { internalPort: 4000, label: 'api' },
      ],
      healthPath: '/healthz',
      readyTimeoutMs: 90000,
      cwd: 'apps/web',
    });
  });
});

describe('buildSecretsSnapshotPayload', () => {
  it('returns null for an empty snapshot (rollback = clear all)', () => {
    expect(buildSecretsSnapshotPayload([])).toBeNull();
  });

  it('reproduces the stored set with MASK for secrets and plaintext for plain', () => {
    const payload = buildSecretsSnapshotPayload([
      { key: 'STRIPE', kind: 'secret' },
      { key: 'PUBLIC_URL', kind: 'plain', value: 'https://x' },
    ])!;
    expect(payload).toEqual([
      { key: 'STRIPE', value: SECRET_MASK, kind: 'secret' },
      { key: 'PUBLIC_URL', value: 'https://x', kind: 'plain' },
    ]);
  });
});

describe('buildSecretsPutPayload', () => {
  it('returns null when there is nothing to write', () => {
    expect(buildSecretsPutPayload(baseForm(), [])).toBeNull();
  });

  it('returns null when no secret value was freshly typed', () => {
    const form = baseForm({ secretRows: [{ key: 'TOKEN', value: '', hadSecret: true }] });
    expect(buildSecretsPutPayload(form, [{ key: 'TOKEN', kind: 'secret' }])).toBeNull();
  });

  it('preserves existing secrets with the MASK sentinel and upserts typed values', () => {
    const form = baseForm({
      secretRows: [
        { key: 'STRIPE', value: 'sk_new', hadSecret: true },
        { key: 'DB_PASS', value: '', hadSecret: true },
      ],
    });
    const existing = [
      { key: 'STRIPE', kind: 'secret' as const },
      { key: 'DB_PASS', kind: 'secret' as const },
      { key: 'PUBLIC_URL', kind: 'plain' as const, value: 'https://x' },
    ];
    const payload = buildSecretsPutPayload(form, existing)!;
    expect(payload).toContainEqual({ key: 'STRIPE', value: 'sk_new', kind: 'secret' });
    // Unchanged secret keeps ciphertext via MASK — plaintext never re-sent.
    expect(payload).toContainEqual({ key: 'DB_PASS', value: SECRET_MASK, kind: 'secret' });
    // Unrelated plain secret is preserved verbatim.
    expect(payload).toContainEqual({ key: 'PUBLIC_URL', value: 'https://x', kind: 'plain' });
  });

  it('never emits a plaintext value for a stored, untouched secret', () => {
    const form = baseForm({ secretRows: [{ key: 'NEW_ONE', value: 'fresh', hadSecret: false }] });
    const existing = [{ key: 'OLD', kind: 'secret' as const }];
    const payload = buildSecretsPutPayload(form, existing)!;
    const old = payload.find((p) => p.key === 'OLD')!;
    expect(old.value).toBe(SECRET_MASK);
    expect(payload).toContainEqual({ key: 'NEW_ONE', value: 'fresh', kind: 'secret' });
  });
});

describe('aptPackages', () => {
  it('maps a saved aptPackages array into newline-joined text', () => {
    const form = devServerFormFromProject({
      prEnv: { devServer: { aptPackages: ['imagemagick', 'libmagickwand-dev'] } },
    });
    expect(form.aptPackagesText).toBe('imagemagick\nlibmagickwand-dev');
  });

  it('includes parsed apt packages in the built config (space/newline separated)', () => {
    const cfg = buildDevServerConfig(
      baseForm({ aptPackagesText: 'imagemagick  libmagickwand-dev\ngdal-bin' }),
    );
    expect(cfg.aptPackages).toEqual(['imagemagick', 'libmagickwand-dev', 'gdal-bin']);
  });

  it('omits aptPackages when the field is blank', () => {
    const cfg = buildDevServerConfig(baseForm({ aptPackagesText: '   ' }));
    expect(cfg).not.toHaveProperty('aptPackages');
  });

  it('round-trips a wizard-authored aptPackages list through the form without dropping it', () => {
    const project = { prEnv: { devServer: { aptPackages: ['imagemagick'] } } };
    const form = devServerFormFromProject(project);
    expect(buildDevServerConfig(form).aptPackages).toEqual(['imagemagick']);
  });

  it('rejects an apt package name with shell metacharacters', () => {
    const err = validateDevServerForm(baseForm({ aptPackagesText: 'imagemagick; rm -rf /' }));
    expect(err?.field).toBe('aptPackages');
    expect(err?.error).toContain('not a valid apt package name');
  });

  it('rejects duplicate apt packages', () => {
    const err = validateDevServerForm(baseForm({ aptPackagesText: 'imagemagick imagemagick' }));
    expect(err?.field).toBe('aptPackages');
    expect(err?.error).toContain('more than once');
  });

  it('accepts a valid versioned apt package', () => {
    expect(validateDevServerForm(baseForm({ aptPackagesText: 'libpq-dev=16.4-1' }))).toBeNull();
  });
});
