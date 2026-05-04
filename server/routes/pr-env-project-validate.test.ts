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
});
