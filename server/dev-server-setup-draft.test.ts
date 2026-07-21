/**
 * Unit tests for the Dev Server setup draft scanner.
 *
 * Pure filesystem reads against temp dirs — no CLI, no network. Covers
 * start-command candidate ordering + package-manager awareness, framework/
 * port inference, explicit `--port` flag override, monorepo detection, the
 * existing-config passthrough, and graceful degradation on a missing/broken
 * package.json.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { collectDevServerSetupDraft } from './dev-server-setup-draft.js';

function tmpProject(files: Record<string, string>): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ah-ds-draft-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(cwd, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return cwd;
}

describe('collectDevServerSetupDraft', () => {
  it('detects npm + vite: recommended start command and default port', () => {
    const cwd = tmpProject({
      'package.json': JSON.stringify({
        scripts: { dev: 'vite', build: 'vite build' },
        devDependencies: { vite: '^5.0.0' },
      }),
      'package-lock.json': '{}',
    });
    const draft = collectDevServerSetupDraft(cwd);
    expect(draft.packageManager).toBe('npm');
    expect(draft.frameworks).toContain('vite');
    const rec = draft.startCommandCandidates.find((c) => c.recommended);
    expect(rec?.command).toBe('npm run dev');
    expect(rec?.script).toBe('dev');
    // Vite default port when no explicit flag is present.
    expect(draft.portGuesses[0]).toMatchObject({ internalPort: 5173, source: 'vite default' });
    expect(draft.healthPathGuess).toBe('/');
    expect(draft.isMonorepo).toBe(false);
  });

  it('is package-manager aware (pnpm → bare script name)', () => {
    const cwd = tmpProject({
      'package.json': JSON.stringify({
        scripts: { dev: 'next dev' },
        dependencies: { next: '14' },
      }),
      'pnpm-lock.yaml': '',
    });
    const draft = collectDevServerSetupDraft(cwd);
    expect(draft.packageManager).toBe('pnpm');
    expect(draft.startCommandCandidates.find((c) => c.recommended)?.command).toBe('pnpm dev');
    expect(draft.frameworks).toContain('next');
  });

  it('an explicit --port flag in the dev script wins over the framework default', () => {
    const cwd = tmpProject({
      'package.json': JSON.stringify({
        scripts: { dev: 'next dev --port 4000' },
        dependencies: { next: '14' },
      }),
      'package-lock.json': '{}',
    });
    const draft = collectDevServerSetupDraft(cwd);
    // Flag port comes first; the framework default (3000) still trails it.
    expect(draft.portGuesses[0]).toMatchObject({ internalPort: 4000, source: '--port flag' });
    expect(draft.portGuesses.some((p) => p.internalPort === 3000)).toBe(true);
  });

  it('orders start-command candidates by preference then dev-ish scripts', () => {
    const cwd = tmpProject({
      'package.json': JSON.stringify({
        scripts: { build: 'tsc', start: 'node server.js', dev: 'vite', 'dev:api': 'tsx api.ts' },
      }),
      'yarn.lock': '',
    });
    const draft = collectDevServerSetupDraft(cwd);
    const scripts = draft.startCommandCandidates.map((c) => c.script);
    // `dev` and `start` are preferred names (dev first); build is excluded.
    expect(scripts[0]).toBe('dev');
    expect(scripts).toContain('start');
    expect(scripts).toContain('dev:api');
    expect(scripts).not.toContain('build');
    // yarn also uses the bare script name.
    expect(draft.startCommandCandidates[0].command).toBe('yarn dev');
  });

  it('flags a monorepo and resolves workspace app subdirs shallowly', () => {
    const cwd = tmpProject({
      'package.json': JSON.stringify({ workspaces: ['apps/*'], scripts: { dev: 'turbo dev' } }),
      'package-lock.json': '{}',
      'apps/web/package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'apps/api/package.json': JSON.stringify({ scripts: { dev: 'tsx api.ts' } }),
    });
    const draft = collectDevServerSetupDraft(cwd);
    expect(draft.isMonorepo).toBe(true);
    expect(draft.monorepoDirs.sort()).toEqual([path.join('apps', 'api'), path.join('apps', 'web')]);
  });

  it('passes through the existing config and never throws on a missing package.json', () => {
    const cwd = tmpProject({ 'README.md': '# demo\nRun `npm run dev`.\n' });
    const existing = {
      startCommand: 'npm run dev',
      env: {},
      secretKeys: [],
      portMap: [{ internalPort: 3000, label: 'web', primary: true }],
      aptPackages: [],
    };
    const draft = collectDevServerSetupDraft(cwd, { existing });
    expect(draft.startCommandCandidates).toEqual([]);
    expect(draft.frameworks).toEqual([]);
    expect(draft.packageManager).toBeNull();
    expect(draft.existing).toEqual(existing);
    expect(draft.readme.path).toBe('README.md');
    expect(draft.readme.excerpt).toContain('npm run dev');
  });

  it('degrades gracefully on malformed package.json', () => {
    const cwd = tmpProject({ 'package.json': '{ not json' });
    const draft = collectDevServerSetupDraft(cwd);
    expect(draft.startCommandCandidates).toEqual([]);
    expect(draft.frameworks).toEqual([]);
  });

  it('ignores non-string script bodies without throwing (untrusted package.json)', () => {
    // A parseable package.json whose script body is a number must not reach
    // portFromScript's `.match()` (which would throw → 500 on setup-draft).
    const cwd = tmpProject({
      'package.json': JSON.stringify({
        scripts: { dev: 123, start: { nested: true }, serve: 'vite --port 4100' },
        devDependencies: { vite: '^5.0.0' },
      }),
      'package-lock.json': '{}',
    });
    expect(() => collectDevServerSetupDraft(cwd)).not.toThrow();
    const draft = collectDevServerSetupDraft(cwd);
    const scripts = draft.startCommandCandidates.map((c) => c.script);
    // Non-string `dev`/`start` bodies are dropped; only the string `serve` survives.
    expect(scripts).toEqual(['serve']);
    expect(draft.startCommandCandidates[0].raw).toBe('vite --port 4100');
    // The explicit flag from the only valid script is still parsed.
    expect(draft.portGuesses[0]).toMatchObject({ internalPort: 4100, source: '--port flag' });
  });
});
