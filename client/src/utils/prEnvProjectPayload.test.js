import { describe, it, expect } from 'vitest';
import {
  EMPTY_FORM,
  formFromConfig,
  validateForm,
  generateDefaultDockerfile,
  PR_ENV_PREVIEW_DEFAULT_IDLE_TTL,
  PR_ENV_PREVIEW_MAX_ROUTES,
  PR_ENV_PREVIEW_PORT_MAX,
  PR_ENV_PREVIEW_IDLE_TTL_MAX,
} from './prEnvProjectPayload.js';

/** Default preview block that an untouched form carries. Used by tests that
 *  hydrate from a config without a saved preview slot — keeps the assertion
 *  noise low when only non-preview fields are under test. */
const DEFAULT_PREVIEW = {
  enabled: false,
  startScript: '',
  port: '',
  captureRoutes: [{ value: '/' }],
  idleTTL: String(PR_ENV_PREVIEW_DEFAULT_IDLE_TTL),
};

describe('prEnvProjectPayload — formFromConfig', () => {
  it('returns the empty form when config is null/undefined/non-object', () => {
    expect(formFromConfig(null)).toEqual(EMPTY_FORM);
    expect(formFromConfig(undefined)).toEqual(EMPTY_FORM);
    expect(formFromConfig(42)).toEqual(EMPTY_FORM);
    expect(formFromConfig('nope')).toEqual(EMPTY_FORM);
  });

  it('hydrates every field from a fully-populated config', () => {
    expect(
      formFromConfig({
        enabled: true,
        setupCommand: 'npm install',
        startScript: './scripts/pr-env.sh',
        internalPort: 3000,
        healthPath: '/healthz',
        dockerfilePath: 'docker/preview.Dockerfile',
      }),
    ).toEqual({
      enabled: true,
      setupCommand: 'npm install',
      startScript: './scripts/pr-env.sh',
      internalPort: '3000',
      healthPath: '/healthz',
      dockerfilePath: 'docker/preview.Dockerfile',
      envRows: [],
      preview: DEFAULT_PREVIEW,
    });
  });

  it('coerces missing optional fields to empty strings rather than undefined', () => {
    const form = formFromConfig({ enabled: true, startScript: 'npm start', internalPort: 8080 });
    expect(form.enabled).toBe(true);
    expect(form.startScript).toBe('npm start');
    expect(form.internalPort).toBe('8080');
    expect(form.setupCommand).toBe('');
    expect(form.healthPath).toBe('');
    expect(form.dockerfilePath).toBe('');
    expect(form.envRows).toEqual([]);
  });

  it('hydrates envRows from a saved env Record in insertion order', () => {
    const form = formFromConfig({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      env: {
        AWS_ACCESS_KEY_ID: 'AKIATEST',
        UPSTREAM_API_URL: 'https://api.example.com',
      },
    });
    expect(form.envRows).toEqual([
      { key: 'AWS_ACCESS_KEY_ID', value: 'AKIATEST' },
      { key: 'UPSTREAM_API_URL', value: 'https://api.example.com' },
    ]);
  });

  it('returns an empty envRows when env is missing or non-object', () => {
    expect(formFromConfig({ enabled: true, startScript: 'x', internalPort: 1 }).envRows).toEqual(
      [],
    );
    expect(
      formFromConfig({ enabled: true, startScript: 'x', internalPort: 1, env: null }).envRows,
    ).toEqual([]);
    expect(
      formFromConfig({
        enabled: true,
        startScript: 'x',
        internalPort: 1,
        env: 'AWS_KEY=x',
      }).envRows,
    ).toEqual([]);
  });

  it('drops a non-finite internalPort to an empty string', () => {
    expect(formFromConfig({ enabled: true, internalPort: NaN }).internalPort).toBe('');
    expect(formFromConfig({ enabled: true, internalPort: Infinity }).internalPort).toBe('');
  });
});

describe('prEnvProjectPayload — validateForm', () => {
  it('passes through enabled=false without requiring any other field', () => {
    const result = validateForm({ ...EMPTY_FORM, enabled: false });
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ enabled: false });
  });

  it('requires startScript and internalPort when enabled', () => {
    const result = validateForm({ ...EMPTY_FORM, enabled: true });
    expect(result.ok).toBe(false);
    expect(result.errors.startScript).toMatch(/required/i);
    expect(result.errors.internalPort).toMatch(/required/i);
  });

  it('rejects a non-integer port', () => {
    const result = validateForm({
      ...EMPTY_FORM,
      enabled: true,
      startScript: 'npm start',
      internalPort: '3.14',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.internalPort).toMatch(/integer/i);
  });

  it('rejects an out-of-range port', () => {
    expect(
      validateForm({ ...EMPTY_FORM, enabled: true, startScript: 'x', internalPort: '0' }).ok,
    ).toBe(false);
    expect(
      validateForm({ ...EMPTY_FORM, enabled: true, startScript: 'x', internalPort: '65536' }).ok,
    ).toBe(false);
  });

  it('rejects a healthPath that does not start with /', () => {
    const result = validateForm({
      ...EMPTY_FORM,
      enabled: true,
      startScript: 'npm start',
      internalPort: '3000',
      healthPath: 'healthz',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.healthPath).toMatch(/^Health path must start with/);
  });

  it('rejects an absolute dockerfilePath', () => {
    const result = validateForm({
      ...EMPTY_FORM,
      enabled: true,
      startScript: 'npm start',
      internalPort: '3000',
      dockerfilePath: '/etc/passwd',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.dockerfilePath).toMatch(/relative/i);
  });

  it('rejects a dockerfilePath that escapes the repo root via ..', () => {
    const result = validateForm({
      ...EMPTY_FORM,
      enabled: true,
      startScript: 'npm start',
      internalPort: '3000',
      dockerfilePath: '../../etc/passwd',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.dockerfilePath).toMatch(/escape/i);
  });

  it('builds a clean payload with only the optional fields the user set', () => {
    const result = validateForm({
      ...EMPTY_FORM,
      enabled: true,
      startScript: '  npm start  ',
      internalPort: '3000',
      setupCommand: '',
      healthPath: '',
      dockerfilePath: '',
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      // EMPTY_FORM carries an untouched preview block whose toggle is
      // off — we round-trip the explicit `{enabled:false}` slot so the
      // server can preserve / clear the saved value.
      preview: { enabled: false },
    });
  });

  it('includes optional fields when populated, trimming whitespace', () => {
    const result = validateForm({
      ...EMPTY_FORM,
      enabled: true,
      startScript: 'npm start',
      internalPort: '8080',
      setupCommand: '  pnpm install  ',
      healthPath: '/ping',
      dockerfilePath: '  preview.Dockerfile  ',
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({
      enabled: true,
      startScript: 'npm start',
      internalPort: 8080,
      setupCommand: 'pnpm install',
      healthPath: '/ping',
      dockerfilePath: 'preview.Dockerfile',
      preview: { enabled: false },
    });
  });

  describe('env vars', () => {
    const baseForm = {
      ...EMPTY_FORM,
      enabled: true,
      startScript: 'npm start',
      internalPort: '3000',
    };

    it('drops blank rows silently and emits a Record only when at least one row is set', () => {
      const result = validateForm({
        ...baseForm,
        envRows: [
          { key: '', value: '' },
          { key: 'AWS_ACCESS_KEY_ID', value: 'AKIATEST' },
          { key: '', value: '' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.payload.env).toEqual({ AWS_ACCESS_KEY_ID: 'AKIATEST' });
    });

    it('omits env from the payload entirely when no rows are set', () => {
      const result = validateForm({
        ...baseForm,
        envRows: [
          { key: '', value: '' },
          { key: '', value: '   ' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.payload.env).toBeUndefined();
    });

    it('flags rows with values but no key', () => {
      const result = validateForm({
        ...baseForm,
        envRows: [{ key: '', value: 'AKIA…' }],
      });
      expect(result.ok).toBe(false);
      expect(result.errors['env.0.key']).toMatch(/required/i);
    });

    it('flags malformed names (dashes, dots, leading digits)', () => {
      const result = validateForm({
        ...baseForm,
        envRows: [
          { key: 'has-dash', value: 'x' },
          { key: '9LEADING', value: 'y' },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors['env.0.key']).toMatch(/letter/i);
      expect(result.errors['env.1.key']).toMatch(/letter/i);
    });

    it('flags duplicate names', () => {
      const result = validateForm({
        ...baseForm,
        envRows: [
          { key: 'AWS_ACCESS_KEY_ID', value: 'one' },
          { key: 'AWS_ACCESS_KEY_ID', value: 'two' },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors['env.1.key']).toMatch(/duplicate/i);
    });

    it('flags PORT as reserved', () => {
      const result = validateForm({
        ...baseForm,
        envRows: [{ key: 'PORT', value: '9999' }],
      });
      expect(result.ok).toBe(false);
      expect(result.errors['env.0.key']).toMatch(/reserved/i);
    });

    it('flags values longer than 4096 characters', () => {
      const result = validateForm({
        ...baseForm,
        envRows: [{ key: 'BIG', value: 'x'.repeat(4097) }],
      });
      expect(result.ok).toBe(false);
      expect(result.errors['env.0.value']).toMatch(/exceeds/i);
    });

    it('reports per-row errors instead of stopping at the first', () => {
      const result = validateForm({
        ...baseForm,
        envRows: [
          { key: 'has-dash', value: 'x' },
          { key: '', value: 'orphan' },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors['env.0.key']).toBeTruthy();
      expect(result.errors['env.1.key']).toBeTruthy();
    });
  });
});

describe('prEnvProjectPayload — preview sub-config', () => {
  const baseForm = {
    ...EMPTY_FORM,
    enabled: true,
    startScript: 'npm start',
    internalPort: '3000',
    preview: { ...DEFAULT_PREVIEW },
  };

  it('hydrates a saved preview block including capture-route values and idleTTL', () => {
    const form = formFromConfig({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      preview: {
        enabled: true,
        startScript: 'npm run dev',
        port: 5173,
        captureRoutes: ['/', '/dashboard'],
        idleTTL: 1800,
      },
    });
    expect(form.preview).toEqual({
      enabled: true,
      startScript: 'npm run dev',
      port: '5173',
      captureRoutes: [{ value: '/' }, { value: '/dashboard' }],
      idleTTL: '1800',
    });
  });

  it('falls back to the empty preview block when the saved config omits one', () => {
    const form = formFromConfig({ enabled: true, startScript: 'x', internalPort: 1 });
    expect(form.preview).toEqual(DEFAULT_PREVIEW);
  });

  it('treats a non-array captureRoutes as a default ["/"] row', () => {
    const form = formFromConfig({
      enabled: true,
      startScript: 'x',
      internalPort: 1,
      preview: { enabled: true, captureRoutes: 'oops' },
    });
    expect(form.preview.captureRoutes).toEqual([{ value: '/' }]);
  });

  it('omits the preview slot from the payload when toggle is off', () => {
    const result = validateForm({
      ...baseForm,
      preview: { ...DEFAULT_PREVIEW, enabled: false },
    });
    expect(result.ok).toBe(true);
    expect(result.payload.preview).toEqual({ enabled: false });
  });

  it('emits a clean preview payload when enabled with all four fields populated', () => {
    const result = validateForm({
      ...baseForm,
      preview: {
        enabled: true,
        startScript: '  npm run dev  ',
        port: '5173',
        captureRoutes: [{ value: '/' }, { value: '/board' }],
        idleTTL: '600',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.payload.preview).toEqual({
      enabled: true,
      startScript: 'npm run dev',
      port: 5173,
      captureRoutes: ['/', '/board'],
      idleTTL: 600,
    });
  });

  it('drops blank capture-route rows silently and only emits real entries', () => {
    const result = validateForm({
      ...baseForm,
      preview: {
        enabled: true,
        startScript: '',
        port: '',
        captureRoutes: [{ value: '' }, { value: '/board' }, { value: '   ' }],
        idleTTL: '600',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.payload.preview.captureRoutes).toEqual(['/board']);
  });

  it('rejects a capture-route that does not start with /', () => {
    const result = validateForm({
      ...baseForm,
      preview: {
        ...DEFAULT_PREVIEW,
        enabled: true,
        captureRoutes: [{ value: '/' }, { value: 'oops' }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors['preview.captureRoutes.1']).toMatch(/start with/);
  });

  it('rejects a port outside the 1024–65535 range', () => {
    const tooLow = validateForm({
      ...baseForm,
      preview: { ...DEFAULT_PREVIEW, enabled: true, port: '80' },
    });
    expect(tooLow.ok).toBe(false);
    expect(tooLow.errors['preview.port']).toMatch(/integer/i);

    const tooHigh = validateForm({
      ...baseForm,
      preview: { ...DEFAULT_PREVIEW, enabled: true, port: String(PR_ENV_PREVIEW_PORT_MAX + 1) },
    });
    expect(tooHigh.ok).toBe(false);
    expect(tooHigh.errors['preview.port']).toMatch(/integer/i);
  });

  it('rejects an idleTTL outside the 60–86400 range', () => {
    const tooLow = validateForm({
      ...baseForm,
      preview: { ...DEFAULT_PREVIEW, enabled: true, idleTTL: '30' },
    });
    expect(tooLow.ok).toBe(false);
    expect(tooLow.errors['preview.idleTTL']).toMatch(/seconds/i);

    const tooHigh = validateForm({
      ...baseForm,
      preview: {
        ...DEFAULT_PREVIEW,
        enabled: true,
        idleTTL: String(PR_ENV_PREVIEW_IDLE_TTL_MAX + 1),
      },
    });
    expect(tooHigh.ok).toBe(false);
    expect(tooHigh.errors['preview.idleTTL']).toMatch(/seconds/i);
  });

  it(`flags a capture-route list above ${PR_ENV_PREVIEW_MAX_ROUTES} entries`, () => {
    const tooMany = Array.from({ length: PR_ENV_PREVIEW_MAX_ROUTES + 1 }, (_, i) => ({
      value: `/r${i}`,
    }));
    const result = validateForm({
      ...baseForm,
      preview: { ...DEFAULT_PREVIEW, enabled: true, captureRoutes: tooMany },
    });
    expect(result.ok).toBe(false);
    expect(result.errors['preview.captureRoutes']).toMatch(/at most/i);
  });
});

describe('prEnvProjectPayload — generateDefaultDockerfile', () => {
  it('produces a syntactically plausible Dockerfile with sensible defaults', () => {
    const out = generateDefaultDockerfile({});
    expect(out).toMatch(/^FROM node:20/m);
    expect(out).toMatch(/^WORKDIR \/workspace/m);
    expect(out).toMatch(/^EXPOSE 3000/m);
    expect(out).toMatch(/^ENV PORT=3000/m);
    expect(out).toMatch(/RUN npm install/);
    expect(out).toMatch(/CMD \["sh", "-c", "npm start"\]/);
  });

  it('respects user-provided values and properly JSON-escapes the start command', () => {
    const out = generateDefaultDockerfile({
      setupCommand: 'pnpm install --frozen-lockfile',
      startScript: 'node "dist/index.js"',
      internalPort: 8080,
    });
    expect(out).toMatch(/RUN pnpm install --frozen-lockfile/);
    expect(out).toMatch(/EXPOSE 8080/);
    expect(out).toMatch(/ENV PORT=8080/);
    // Inner double-quotes must be escaped via JSON.stringify.
    expect(out).toContain('CMD ["sh", "-c", "node \\"dist/index.js\\""]');
  });

  it('clamps a non-integer port to the default 3000', () => {
    const out = generateDefaultDockerfile({ internalPort: 'abc' });
    expect(out).toMatch(/EXPOSE 3000/);
  });
});
