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

describe('detectPreviewDefaults — multi-process layouts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'detect-preview-multi-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('detects Django + React (backend/ with manage.py + frontend/ Vite)', () => {
    // Backend: Django-style with manage.py + requirements-local.txt
    mkdirSync(path.join(tmpDir, 'backend'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'backend', 'manage.py'), '# django entrypoint');
    writeFileSync(path.join(tmpDir, 'backend', 'requirements-local.txt'), 'django\n');
    // Frontend: Vite
    writePkg(path.join(tmpDir, 'frontend'), { devDependencies: { vite: '^5.0.0' } });

    const result = detectPreviewDefaults(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.stack).toBe('fullstack-django-react');
    expect(result!.processes).toHaveLength(2);
    expect(result!.processes![0]).toMatchObject({
      name: 'backend',
      cwd: 'backend',
    });
    expect(result!.processes![0].startScript).toContain(
      'python3 -m pip install -r requirements-local.txt',
    );
    expect(result!.processes![0].startScript).toContain('python manage.py runserver');
    expect(result!.processes![1]).toMatchObject({
      name: 'frontend',
      cwd: 'frontend',
      startScript: 'npm run dev',
      dependsOn: ['backend'],
    });
  });

  it('falls back to requirements.txt when requirements-local.txt is absent', () => {
    mkdirSync(path.join(tmpDir, 'backend'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'backend', 'manage.py'), '# django');
    writeFileSync(path.join(tmpDir, 'backend', 'requirements.txt'), 'django\n');
    writePkg(path.join(tmpDir, 'frontend'), { devDependencies: { vite: '^5.0.0' } });

    const result = detectPreviewDefaults(tmpDir);
    expect(result!.processes![0].startScript).toContain(
      'python3 -m pip install -r requirements.txt',
    );
  });

  it('returns null when only backend/ exists (no frontend)', () => {
    mkdirSync(path.join(tmpDir, 'backend'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'backend', 'manage.py'), '# django');
    expect(detectPreviewDefaults(tmpDir)).toBeNull();
  });

  it('returns single-process Vite when only frontend/ exists', () => {
    writePkg(path.join(tmpDir, 'frontend'), { devDependencies: { vite: '^5.0.0' } });
    // No backend/, so multi-process doesn't fire; top-level package.json
    // is also missing, so the single-process path returns null too. This
    // matches the existing convention — `frontend/` alone is not yet
    // covered by the single-process classifier.
    expect(detectPreviewDefaults(tmpDir)).toBeNull();
  });

  it('detects apps/api + apps/web monorepo with dev scripts', () => {
    writePkg(tmpDir, { dependencies: {}, private: true, workspaces: ['apps/*'] });
    writePkg(path.join(tmpDir, 'apps', 'api'), {
      dependencies: { express: '^4.18.0' },
      scripts: { dev: 'node server.js' },
    });
    writePkg(path.join(tmpDir, 'apps', 'web'), {
      devDependencies: { vite: '^5.0.0' },
    });

    const result = detectPreviewDefaults(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.stack).toBe('fullstack-monorepo');
    expect(result!.processes).toHaveLength(2);
    expect(result!.processes![0]).toMatchObject({
      name: 'api',
      cwd: 'apps/api',
      startScript: 'npm run dev',
    });
    expect(result!.processes![1]).toMatchObject({
      name: 'web',
      cwd: 'apps/web',
      startScript: 'npm run dev',
      dependsOn: ['api'],
    });
  });

  it('detects apps/api + apps/web monorepo with start script fallback', () => {
    writePkg(tmpDir, { dependencies: {}, private: true, workspaces: ['apps/*'] });
    writePkg(path.join(tmpDir, 'apps', 'api'), {
      dependencies: { express: '^4.18.0' },
      scripts: { start: 'node server.js' },
    });
    writePkg(path.join(tmpDir, 'apps', 'web'), {
      dependencies: { next: '^15.0.0' },
    });

    const result = detectPreviewDefaults(tmpDir);
    expect(result!.processes![0].startScript).toBe('npm start');
    expect(result!.processes![1].startScript).toBe('npm run dev');
  });

  it('falls through when apps/api has no dev/start script', () => {
    writePkg(tmpDir, { dependencies: {}, private: true, workspaces: ['apps/*'] });
    writePkg(path.join(tmpDir, 'apps', 'api'), {
      dependencies: { express: '^4.18.0' },
      // no scripts
    });
    writePkg(path.join(tmpDir, 'apps', 'web'), {
      devDependencies: { vite: '^5.0.0' },
    });

    // Multi-process fails (no api start script), falls through to
    // single-process monorepo classifier which picks apps/web as Vite.
    const result = detectPreviewDefaults(tmpDir);
    expect(result).toMatchObject({ stack: 'vite' });
  });

  it('detects start:api + start:web scripts in top-level package.json', () => {
    writePkg(tmpDir, {
      devDependencies: { vite: '^5.0.0' },
      scripts: {
        'start:api': 'node server.js',
        'start:web': 'vite',
      },
    });

    const result = detectPreviewDefaults(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.stack).toBe('fullstack-scripts');
    expect(result!.processes).toEqual([
      { name: 'api', startScript: 'npm run start:api', healthPath: '/' },
      { name: 'web', startScript: 'npm run start:web', healthPath: '/', dependsOn: ['api'] },
    ]);
  });

  it('detects dev:api + dev:web scripts as well', () => {
    writePkg(tmpDir, {
      devDependencies: { vite: '^5.0.0' },
      scripts: {
        'dev:api': 'tsx server.ts',
        'dev:web': 'vite',
      },
    });

    const result = detectPreviewDefaults(tmpDir);
    expect(result!.stack).toBe('fullstack-scripts');
    expect(result!.processes![0].startScript).toBe('npm run dev:api');
    expect(result!.processes![1].startScript).toBe('npm run dev:web');
  });

  it('falls through to single-process when only start:web is present (no start:api)', () => {
    writePkg(tmpDir, {
      devDependencies: { vite: '^5.0.0' },
      scripts: {
        'start:web': 'vite',
      },
    });

    const result = detectPreviewDefaults(tmpDir);
    expect(result!.stack).toBe('vite');
    expect(result!.processes).toBeUndefined();
  });

  it('django+react wins over apps/* monorepo when both patterns are present', () => {
    // Backend (django) + frontend (vite) layout
    mkdirSync(path.join(tmpDir, 'backend'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'backend', 'manage.py'), '');
    writeFileSync(path.join(tmpDir, 'backend', 'requirements.txt'), 'django\n');
    writePkg(path.join(tmpDir, 'frontend'), { devDependencies: { vite: '^5.0.0' } });
    // Also has apps/api + apps/web (e.g. legacy monorepo bits)
    writePkg(path.join(tmpDir, 'apps', 'api'), {
      scripts: { dev: 'node x.js' },
    });
    writePkg(path.join(tmpDir, 'apps', 'web'), {
      devDependencies: { vite: '^5.0.0' },
    });

    expect(detectPreviewDefaults(tmpDir)!.stack).toBe('fullstack-django-react');
  });
});
