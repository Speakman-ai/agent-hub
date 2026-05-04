import { describe, it, expect } from 'vitest';
import { validatePrEnvProjectConfig } from './projects.js';

describe('validatePrEnvProjectConfig', () => {
  it('rejects non-objects', () => {
    expect(validatePrEnvProjectConfig(null).ok).toBe(false);
    expect(validatePrEnvProjectConfig(undefined).ok).toBe(false);
    expect(validatePrEnvProjectConfig('nope').ok).toBe(false);
    expect(validatePrEnvProjectConfig(42).ok).toBe(false);
    expect(validatePrEnvProjectConfig([]).ok).toBe(false);
  });

  it('accepts enabled=false on its own (disable path)', () => {
    const r = validatePrEnvProjectConfig({ enabled: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ enabled: false });
  });

  it('rejects when enabled but no startScript', () => {
    const r = validatePrEnvProjectConfig({ enabled: true, internalPort: 3000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/startScript/);
  });

  it('rejects when enabled but startScript is whitespace-only', () => {
    const r = validatePrEnvProjectConfig({
      enabled: true,
      startScript: '   ',
      internalPort: 3000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/startScript/);
  });

  it('rejects an out-of-range port', () => {
    const r1 = validatePrEnvProjectConfig({
      enabled: true,
      startScript: 'npm start',
      internalPort: 0,
    });
    expect(r1.ok).toBe(false);
    const r2 = validatePrEnvProjectConfig({
      enabled: true,
      startScript: 'npm start',
      internalPort: 70000,
    });
    expect(r2.ok).toBe(false);
  });

  it('coerces a numeric string port to a number', () => {
    const r = validatePrEnvProjectConfig({
      enabled: true,
      startScript: 'npm start',
      internalPort: '8080',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.internalPort).toBe(8080);
  });

  it('rejects a non-integer port string', () => {
    const r = validatePrEnvProjectConfig({
      enabled: true,
      startScript: 'npm start',
      internalPort: '3.14',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a healthPath without leading /', () => {
    const r = validatePrEnvProjectConfig({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      healthPath: 'healthz',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/healthPath/);
  });

  it('strips empty optional fields and trims whitespace', () => {
    const r = validatePrEnvProjectConfig({
      enabled: true,
      startScript: '  npm start  ',
      internalPort: 3000,
      setupCommand: '   ',
      healthPath: '',
      dockerfilePath: '',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
    });
  });

  it('rejects an absolute dockerfilePath', () => {
    const r = validatePrEnvProjectConfig({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      dockerfilePath: '/etc/passwd',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/dockerfilePath/);
    expect(r.error).toMatch(/relative/i);
  });

  it('rejects a dockerfilePath that escapes the repo root via ..', () => {
    const r = validatePrEnvProjectConfig({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      dockerfilePath: '../../etc/passwd',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/dockerfilePath/);
    expect(r.error).toMatch(/escape/i);
  });

  it('passes through populated optional fields', () => {
    const r = validatePrEnvProjectConfig({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      setupCommand: 'npm install',
      healthPath: '/healthz',
      dockerfilePath: 'docker/preview.Dockerfile',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      setupCommand: 'npm install',
      healthPath: '/healthz',
      dockerfilePath: 'docker/preview.Dockerfile',
    });
  });

  describe('env (per-project environment variables)', () => {
    const base = { enabled: true, startScript: 'npm start', internalPort: 3000 };

    it('accepts an absent / empty env map (omits the field on the value)', () => {
      const r1 = validatePrEnvProjectConfig({ ...base });
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.value.env).toBeUndefined();

      const r2 = validatePrEnvProjectConfig({ ...base, env: {} });
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.value.env).toBeUndefined();
    });

    it('passes through a flat string→string map', () => {
      const r = validatePrEnvProjectConfig({
        ...base,
        env: {
          AWS_ACCESS_KEY_ID: 'AKIATEST',
          UPSTREAM_API_URL: 'https://api.example.com',
        },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.env).toEqual({
        AWS_ACCESS_KEY_ID: 'AKIATEST',
        UPSTREAM_API_URL: 'https://api.example.com',
      });
    });

    it('rejects non-object env (array, string, number)', () => {
      for (const bad of [[], 'AWS_KEY=x', 42]) {
        const r = validatePrEnvProjectConfig({ ...base, env: bad });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/prEnv\.env/);
      }
    });

    it('rejects non-string values (numbers, booleans, nested objects)', () => {
      for (const bad of [42, true, { nested: 'x' }, null]) {
        const r = validatePrEnvProjectConfig({ ...base, env: { FOO: bad } });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/FOO/);
      }
    });

    it('rejects names that are not POSIX-style identifiers', () => {
      const bad = ['9_LEADS_DIGIT', 'has-dash', 'has.dot', 'has space', ''];
      for (const key of bad) {
        const r = validatePrEnvProjectConfig({ ...base, env: { [key]: 'v' } });
        expect(r.ok).toBe(false);
      }
    });

    it('rejects PORT (reserved — runner sets it from internalPort)', () => {
      const r = validatePrEnvProjectConfig({ ...base, env: { PORT: '4000' } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/reserved/i);
    });

    it('rejects more than 64 entries', () => {
      const env: Record<string, string> = {};
      for (let i = 0; i < 65; i++) env[`VAR_${i}`] = 'x';
      const r = validatePrEnvProjectConfig({ ...base, env });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/at most 64/i);
    });

    it('rejects values longer than 4096 chars', () => {
      const r = validatePrEnvProjectConfig({
        ...base,
        env: { LONG: 'x'.repeat(4097) },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/LONG/);
    });
  });
});
