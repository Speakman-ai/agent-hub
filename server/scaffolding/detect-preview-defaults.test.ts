import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';

import {
  detectPreviewDefaults,
  classifyPackageJson,
  parseComposeHostPort,
} from './detect-preview-defaults.js';

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

  it('detects docker compose and prefers a published host port', () => {
    writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      'services:\n  web:\n    ports:\n      - "8088:8000"\n',
    );
    expect(detectPreviewDefaults(tmpDir)).toMatchObject({
      stack: 'compose',
      startScript: 'docker compose up --build',
      port: 8088,
    });
  });

  it('detects a Dockerfile when compose is absent and builds+runs the EXPOSEd port', () => {
    writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM python:3.12\nEXPOSE 9100\n');
    const detected = detectPreviewDefaults(tmpDir);
    expect(detected).toMatchObject({ stack: 'docker', port: 9100 });
    // A Dockerfile-only repo has no Compose file, so it must NOT be handed a
    // `docker compose` command that would deterministically fail.
    expect(detected?.startScript).not.toContain('docker compose');
    expect(detected?.startScript).toBe(
      'docker build -t agent-hub-preview . && docker run --rm -p 9100:9100 agent-hub-preview',
    );
  });

  it('falls back to port 8000 for a Dockerfile with no EXPOSE', () => {
    writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM python:3.12\n');
    const detected = detectPreviewDefaults(tmpDir);
    expect(detected).toMatchObject({ stack: 'docker', port: 8000 });
    expect(detected?.startScript).toBe(
      'docker build -t agent-hub-preview . && docker run --rm -p 8000:8000 agent-hub-preview',
    );
  });

  it('detects FastAPI from pyproject.toml with a runnable uvicorn command', () => {
    writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\ndependencies = ["fastapi"]\n');
    const detected = detectPreviewDefaults(tmpDir);
    expect(detected).toMatchObject({ stack: 'fastapi', port: 8000 });
    expect(detected?.startScript).not.toContain('docker compose');
    expect(detected?.startScript).toBe('uvicorn main:app --host 0.0.0.0 --port 8000');
  });

  it('detects Django with a runserver command', () => {
    writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django\n');
    const detected = detectPreviewDefaults(tmpDir);
    expect(detected).toMatchObject({ stack: 'django', port: 8000 });
    expect(detected?.startScript).toBe('python manage.py runserver 0.0.0.0:8000');
  });

  it('detects Flask with a flask run command', () => {
    writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask\n');
    const detected = detectPreviewDefaults(tmpDir);
    expect(detected).toMatchObject({ stack: 'flask', port: 5000 });
    expect(detected?.startScript).toBe('flask run --host=0.0.0.0 --port=5000');
  });

  it('detects Go from go.mod with a go run command (no compose)', () => {
    writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/app\n');
    const detected = detectPreviewDefaults(tmpDir);
    expect(detected).toMatchObject({ stack: 'go', port: 8080 });
    expect(detected?.startScript).not.toContain('docker compose');
    expect(detected?.startScript).toBe('go run .');
  });

  it('detects Rust from Cargo.toml with a cargo run command (no compose)', () => {
    writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "app"\n');
    const detected = detectPreviewDefaults(tmpDir);
    expect(detected).toMatchObject({ stack: 'rust', port: 3000 });
    expect(detected?.startScript).not.toContain('docker compose');
    expect(detected?.startScript).toBe('cargo run');
  });

  it('still uses compose when a Compose file accompanies a language manifest', () => {
    writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/app\n');
    writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      'services:\n  web:\n    ports:\n      - "8080:8080"\n',
    );
    // Compose is checked before the language branches, so a repo that ships
    // a Compose file keeps the compose command.
    expect(detectPreviewDefaults(tmpDir)).toMatchObject({
      stack: 'compose',
      startScript: 'docker compose up --build',
    });
  });
});

describe('parseComposeHostPort', () => {
  it('reads the first host:container mapping', () => {
    expect(parseComposeHostPort('ports:\n  - "9000:80"\n')).toBe(9000);
    expect(parseComposeHostPort('no ports here')).toBeNull();
  });
});
