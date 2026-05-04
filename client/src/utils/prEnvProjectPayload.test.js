import { describe, it, expect } from 'vitest';
import {
  EMPTY_FORM,
  formFromConfig,
  validateForm,
  generateDefaultDockerfile,
} from './prEnvProjectPayload.js';

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
    });
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
