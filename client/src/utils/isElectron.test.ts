import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isElectron } from './isElectron';

describe('isElectron()', () => {
  let origWindow: any;

  beforeEach(() => {
    origWindow = globalThis.window;
  });

  afterEach(() => {
    (globalThis as any).window = origWindow;
  });

  it('returns false when window is undefined (SSR / Node)', () => {
    delete (globalThis as any).window;
    expect(isElectron()).toBe(false);
  });

  it('returns false when window.electronAPI is missing (plain browser)', () => {
    (globalThis as any).window = {};
    expect(isElectron()).toBe(false);
  });

  it('returns false when window.electronAPI.isElectron is explicitly false', () => {
    (globalThis as any).window = { electronAPI: { isElectron: false } };
    expect(isElectron()).toBe(false);
  });

  it('returns true when the Electron preload bridge is present', () => {
    (globalThis as any).window = { electronAPI: { isElectron: true } };
    expect(isElectron()).toBe(true);
  });

  it('coerces truthy bridge values to a strict boolean', () => {
    // The preload script always uses `true`, but if some future bridge
    // exposed a truthy non-boolean (e.g. version string) we still want a
    // clean boolean from the helper.
    (globalThis as any).window = { electronAPI: { isElectron: 'yes' } };
    expect(isElectron()).toBe(true);
  });
});
