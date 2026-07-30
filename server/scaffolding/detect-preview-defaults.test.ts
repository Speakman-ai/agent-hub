import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';

import { detectPreviewDefaults, classifyPackageJson } from './detect-preview-defaults.js';

function writePkg(dir: string, contents: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(contents, null, 2));
}

describe('classifyPackageJson', () => {
  it('classifies vite from devDependencies', () => {
    expect(classifyPackageJson({ devDependencies: { vite: '^5.0.0' } })).toBe('vite');
  });

  it('classifies next from dependencies', () => {
    expect(classifyPackageJson({ dependencies: { next: '^15.0.0' } })).toBe('next');
  });

  it('classifies create-react-app from react-scripts', () => {
    expect(classifyPackageJson({ dependencies: { 'react-scripts': '5.0.1' } })).toBe('cra');
  });

  it('classifies astro', () => {
    expect(classifyPackageJson({ devDependencies: { astro: '^4.0.0' } })).toBe('astro');
  });

  it('classifies nuxt (v3)', () => {
    expect(classifyPackageJson({ devDependencies: { nuxt: '^3.0.0' } })).toBe('nuxt');
  });

  it('classifies nuxt3 alias', () => {
    expect(classifyPackageJson({ devDependencies: { nuxt3: '^3.0.0' } })).toBe('nuxt');
  });

  it('classifies expo from dependencies', () => {
    expect(classifyPackageJson({ dependencies: { expo: '~50.0.0' } })).toBe('expo');
  });

  it('returns null when no recognised dep is present', () => {
    expect(classifyPackageJson({ dependencies: { lodash: '^4.0.0' } })).toBeNull();
  });

  it('prefers next over vite when both are present', () => {
    expect(
      classifyPackageJson({
        dependencies: { next: '^15.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    ).toBe('next');
  });

  it('prefers nuxt over vite when both are present', () => {
    expect(
      classifyPackageJson({
        dependencies: { nuxt: '^3.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    ).toBe('nuxt');
  });
});

describe('detectPreviewDefaults', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'detect-preview-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('returns null for a non-existent workspace', () => {
    expect(detectPreviewDefaults('/nonexistent/path/that/should/not/exist')).toBeNull();
  });

  it('returns null when called with a non-string', () => {
    // @ts-expect-error intentional bad input
    expect(detectPreviewDefaults(undefined)).toBeNull();
    // @ts-expect-error intentional bad input
    expect(detectPreviewDefaults(null)).toBeNull();
  });

  it('returns null for a workspace without package.json', () => {
    expect(detectPreviewDefaults(tmpDir)).toBeNull();
  });

  it('returns null when package.json is malformed', () => {
    writeFileSync(path.join(tmpDir, 'package.json'), '{ not valid json');
    expect(detectPreviewDefaults(tmpDir)).toBeNull();
  });

  it('detects vite with port 5173', () => {
    writePkg(tmpDir, { devDependencies: { vite: '^5.0.0' } });
    expect(detectPreviewDefaults(tmpDir)).toEqual({
      stack: 'vite',
      startScript: 'npm run dev',
      port: 5173,
      captureRoutes: ['/'],
      idleTTL: 600,
    });
  });

  it('detects next with port 3000', () => {
    writePkg(tmpDir, { dependencies: { next: '^15.0.0' } });
    expect(detectPreviewDefaults(tmpDir)).toEqual({
      stack: 'next',
      startScript: 'npm run dev',
      port: 3000,
      captureRoutes: ['/'],
      idleTTL: 600,
    });
  });

  it('detects create-react-app with port 3000 and `npm start`', () => {
    writePkg(tmpDir, { dependencies: { 'react-scripts': '5.0.1' } });
    expect(detectPreviewDefaults(tmpDir)).toEqual({
      stack: 'cra',
      startScript: 'npm start',
      port: 3000,
      captureRoutes: ['/'],
      idleTTL: 600,
    });
  });

  it('detects astro with port 4321', () => {
    writePkg(tmpDir, { devDependencies: { astro: '^4.0.0' } });
    expect(detectPreviewDefaults(tmpDir)).toEqual({
      stack: 'astro',
      startScript: 'npm run dev',
      port: 4321,
      captureRoutes: ['/'],
      idleTTL: 600,
    });
  });

  it('detects nuxt with port 3000', () => {
    writePkg(tmpDir, { devDependencies: { nuxt: '^3.0.0' } });
    expect(detectPreviewDefaults(tmpDir)).toEqual({
      stack: 'nuxt',
      startScript: 'npm run dev',
      port: 3000,
      captureRoutes: ['/'],
      idleTTL: 600,
    });
  });

  it('detects expo (web) with port 19006', () => {
    writePkg(tmpDir, { dependencies: { expo: '~50.0.0' } });
    expect(detectPreviewDefaults(tmpDir)).toEqual({
      stack: 'expo',
      startScript: 'npm run web',
      port: 19006,
      captureRoutes: ['/'],
      idleTTL: 600,
    });
  });

  it('returns null for an unknown stack', () => {
    writePkg(tmpDir, { dependencies: { lodash: '^4.0.0', express: '^4.18.0' } });
    expect(detectPreviewDefaults(tmpDir)).toBeNull();
  });

  it('falls back to apps/* in a monorepo', () => {
    // Top-level package.json has nothing recognisable
    writePkg(tmpDir, { dependencies: {}, private: true, workspaces: ['apps/*'] });
    // apps/web is a Vite app
    writePkg(path.join(tmpDir, 'apps', 'web'), { devDependencies: { vite: '^5.0.0' } });
    expect(detectPreviewDefaults(tmpDir)).toMatchObject({ stack: 'vite', port: 5173 });
  });

  it('returns null in a monorepo with only unknown apps', () => {
    writePkg(tmpDir, { dependencies: {}, private: true, workspaces: ['apps/*'] });
    writePkg(path.join(tmpDir, 'apps', 'api'), { dependencies: { express: '^4.18.0' } });
    expect(detectPreviewDefaults(tmpDir)).toBeNull();
  });

  it('top-level match wins over apps/*', () => {
    writePkg(tmpDir, { dependencies: { next: '^15.0.0' } });
    writePkg(path.join(tmpDir, 'apps', 'web'), { devDependencies: { vite: '^5.0.0' } });
    // Top-level is Next, apps/web is Vite — top-level wins
    expect(detectPreviewDefaults(tmpDir)).toMatchObject({ stack: 'next', port: 3000 });
  });
});
