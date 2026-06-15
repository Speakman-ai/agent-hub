/**
 * Unit tests for the RUM instrumentation detection scanner.
 *
 * Pure function over a temp directory — no DB, no spawning, no network.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { collectRumSetupDraft } from './rum-setup-draft.js';

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ah-rum-draft-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function pkg(deps: Record<string, string>, dev: Record<string, string> = {}): string {
  return JSON.stringify({ name: 'x', dependencies: deps, devDependencies: dev });
}

describe('collectRumSetupDraft — framework detection', () => {
  it('detects Next.js and prefers it over react', () => {
    const dir = makeRepo({
      'package.json': pkg({ next: '14.0.0', react: '18.2.0' }),
      'app/layout.tsx': 'export default function L() {}',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.framework).toBe('next');
    expect(draft.frameworkEvidence).toContain('dependency: next');
  });

  it('detects Nuxt', () => {
    const dir = makeRepo({ 'package.json': pkg({ nuxt: '3.0.0', vue: '3.0.0' }) });
    expect(collectRumSetupDraft(dir).framework).toBe('nuxt');
  });

  it('detects SvelteKit over plain svelte', () => {
    const dir = makeRepo({
      'package.json': pkg({}, { '@sveltejs/kit': '2.0.0', svelte: '4.0.0' }),
    });
    expect(collectRumSetupDraft(dir).framework).toBe('sveltekit');
  });

  it('detects Remix', () => {
    const dir = makeRepo({ 'package.json': pkg({ '@remix-run/react': '2.0.0', react: '18.0.0' }) });
    expect(collectRumSetupDraft(dir).framework).toBe('remix');
  });

  it('detects Astro', () => {
    const dir = makeRepo({ 'package.json': pkg({ astro: '4.0.0' }) });
    expect(collectRumSetupDraft(dir).framework).toBe('astro');
  });

  it('detects Angular', () => {
    const dir = makeRepo({ 'package.json': pkg({ '@angular/core': '17.0.0' }) });
    expect(collectRumSetupDraft(dir).framework).toBe('angular');
  });

  it('detects Vue (no meta-framework)', () => {
    const dir = makeRepo({ 'package.json': pkg({ vue: '3.0.0' }) });
    expect(collectRumSetupDraft(dir).framework).toBe('vue');
  });

  it('detects React (no meta-framework)', () => {
    const dir = makeRepo({ 'package.json': pkg({ react: '18.0.0', 'react-dom': '18.0.0' }) });
    expect(collectRumSetupDraft(dir).framework).toBe('react');
  });

  it('detects vanilla when an HTML doc exists but no UI framework dep', () => {
    const dir = makeRepo({
      'package.json': pkg({ lodash: '4.0.0' }),
      'index.html': '<!doctype html><html></html>',
    });
    expect(collectRumSetupDraft(dir).framework).toBe('vanilla');
  });

  it('detects vanilla with no package.json but an index.html', () => {
    const dir = makeRepo({ 'index.html': '<!doctype html><html></html>' });
    const draft = collectRumSetupDraft(dir);
    expect(draft.framework).toBe('vanilla');
    expect(draft.packageManager).toBeNull();
  });

  it('returns unknown for an empty / non-frontend repo', () => {
    const dir = makeRepo({ 'README.md': '# nothing here' });
    expect(collectRumSetupDraft(dir).framework).toBe('unknown');
  });

  it('does not crash on malformed package.json', () => {
    const dir = makeRepo({ 'package.json': '{not valid json' });
    const draft = collectRumSetupDraft(dir);
    expect(draft.framework).toBe('unknown');
  });
});

describe('collectRumSetupDraft — package manager + typescript', () => {
  it('detects pnpm', () => {
    const dir = makeRepo({ 'package.json': pkg({ react: '18.0.0' }), 'pnpm-lock.yaml': '' });
    expect(collectRumSetupDraft(dir).packageManager).toBe('pnpm');
  });

  it('detects yarn', () => {
    const dir = makeRepo({ 'package.json': pkg({ react: '18.0.0' }), 'yarn.lock': '' });
    expect(collectRumSetupDraft(dir).packageManager).toBe('yarn');
  });

  it('detects bun', () => {
    const dir = makeRepo({ 'package.json': pkg({ react: '18.0.0' }), 'bun.lockb': '' });
    expect(collectRumSetupDraft(dir).packageManager).toBe('bun');
  });

  it('falls back to npm with package.json only', () => {
    const dir = makeRepo({ 'package.json': pkg({ react: '18.0.0' }) });
    expect(collectRumSetupDraft(dir).packageManager).toBe('npm');
  });

  it('flags typescript when tsconfig.json exists', () => {
    const dir = makeRepo({ 'package.json': pkg({ react: '18.0.0' }), 'tsconfig.json': '{}' });
    expect(collectRumSetupDraft(dir).typescript).toBe(true);
  });
});

describe('collectRumSetupDraft — entry candidates + plan', () => {
  it('marks a Next app-router root layout as a client-component insertion (not module-init)', () => {
    const dir = makeRepo({
      'package.json': pkg({ next: '14.0.0' }),
      'app/layout.tsx': 'export default function L() {}',
      'pages/_app.tsx': 'export default function A() {}',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.entryCandidates[0]).toEqual({ path: 'app/layout.tsx', kind: 'root-layout' });
    expect(draft.plan.targetFile).toBe('app/layout.tsx');
    // app/layout.tsx is a Server Component by default — direct module init is unsafe.
    expect(draft.plan.injectionStyle).toBe('client-component');
    expect(draft.plan.notes.some((n) => /use client/i.test(n) && /useEffect/.test(n))).toBe(true);
  });

  it('uses module-init for a pages-router _app (browser component)', () => {
    const dir = makeRepo({
      'package.json': pkg({ next: '14.0.0' }),
      'pages/_app.tsx': 'export default function A() {}',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.plan.targetFile).toBe('pages/_app.tsx');
    expect(draft.plan.injectionStyle).toBe('module-init');
  });

  it('uses module-init for a Vite SPA bootstrap', () => {
    const dir = makeRepo({
      'package.json': pkg({ react: '18.0.0' }),
      'src/main.tsx': 'createRoot(el).render(<App/>);',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.plan.targetFile).toBe('src/main.tsx');
    expect(draft.plan.injectionStyle).toBe('module-init');
  });

  it('uses a script-tag plan for a vanilla HTML entry', () => {
    const dir = makeRepo({ 'index.html': '<!doctype html><html><head></head></html>' });
    const draft = collectRumSetupDraft(dir);
    expect(draft.plan.targetFile).toBe('index.html');
    expect(draft.plan.injectionStyle).toBe('script-tag');
  });

  it('returns a null target with a note when no entry file exists', () => {
    const dir = makeRepo({ 'package.json': pkg({ react: '18.0.0' }) });
    const draft = collectRumSetupDraft(dir);
    expect(draft.plan.targetFile).toBeNull();
    expect(draft.plan.injectionStyle).toBeNull();
    expect(draft.plan.notes.some((n) => /which file boots the app/i.test(n))).toBe(true);
  });
});

describe('collectRumSetupDraft — recorder + CSP detection', () => {
  it('flags an already-instrumented app (dependency + init call)', () => {
    const dir = makeRepo({
      'package.json': pkg({ react: '18.0.0', rrweb: '2.0.0' }),
      'src/main.tsx': 'import { record } from "rrweb"; initSessionReplay();',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.recorder.dependencyPresent).toBe(true);
    expect(draft.recorder.initDetected).toBe(true);
    expect(draft.plan.alreadyInstrumented).toBe(true);
    expect(draft.plan.notes.some((n) => /already exists/i.test(n))).toBe(true);
  });

  it('flags a dependency installed but no init wired', () => {
    const dir = makeRepo({
      'package.json': pkg({ react: '18.0.0', '@agent-hub/rum': '1.0.0' }),
      'src/main.tsx': 'import App from "./App"; createRoot(el).render(<App/>);',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.recorder.dependencyPresent).toBe(true);
    expect(draft.recorder.initDetected).toBe(false);
    // A dependency without a wired init still needs setup — must NOT be
    // reported as already instrumented (alreadyInstrumented = dep && init).
    expect(draft.plan.alreadyInstrumented).toBe(false);
    expect(draft.plan.notes.some((n) => /no init call was found/i.test(n))).toBe(true);
  });

  it('does not treat an unused rrweb import as initialized', () => {
    const dir = makeRepo({
      'package.json': pkg({ react: '18.0.0', rrweb: '2.0.0' }),
      // Imported (or type-referenced) but never called — still needs setup.
      'src/main.tsx':
        'import { record } from "rrweb";\nlet opts: rrweb.recordOptions;\nexport default function App() { return null; }',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.recorder.dependencyPresent).toBe(true);
    expect(draft.recorder.initDetected).toBe(false);
    expect(draft.plan.alreadyInstrumented).toBe(false);
  });

  it('does not treat a commented-out init call as initialized', () => {
    const dir = makeRepo({
      'package.json': pkg({ react: '18.0.0', rrweb: '2.0.0' }),
      'src/main.tsx':
        '// initSessionReplay();\n/* record({ emit() {} }); */\nexport default function App() { return null; }',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.recorder.initDetected).toBe(false);
    expect(draft.plan.alreadyInstrumented).toBe(false);
  });

  it('detects a genuine rrweb record({ ... }) call', () => {
    const dir = makeRepo({
      'package.json': pkg({ react: '18.0.0', rrweb: '2.0.0' }),
      'src/main.tsx': 'import { record } from "rrweb"; record({ emit(e) { send(e); } });',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.recorder.initDetected).toBe(true);
    expect(draft.plan.alreadyInstrumented).toBe(true);
  });

  it('does not treat an unrelated record({ ... }) call as rrweb when rrweb is not imported', () => {
    // rrweb is a dependency, but this file is unrelated analytics code that
    // happens to call its own record({ ... }) — must NOT be flagged wired.
    const dir = makeRepo({
      'package.json': pkg({ react: '18.0.0', rrweb: '2.0.0' }),
      'src/main.tsx':
        'import { track } from "./analytics"; track.record({ type: "page-view", url: location.href });',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.recorder.dependencyPresent).toBe(true);
    expect(draft.recorder.initDetected).toBe(false);
    expect(draft.plan.alreadyInstrumented).toBe(false);
  });

  it('detects replay ingest endpoint wiring as instrumented', () => {
    const dir = makeRepo({
      'package.json': pkg({ react: '18.0.0', rrweb: '2.0.0' }),
      'src/main.tsx': 'fetch("/api/replays", { method: "POST", body });',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.recorder.initDetected).toBe(true);
    expect(draft.plan.alreadyInstrumented).toBe(true);
  });

  it('does not flag alreadyInstrumented when an init reference exists but no recorder dependency', () => {
    // Edge case: stray init token in source but the package is not declared
    // as a dependency. Still requires setup, so alreadyInstrumented is false.
    const dir = makeRepo({
      'package.json': pkg({ react: '18.0.0' }),
      'src/main.tsx': 'import App from "./App"; initSessionReplay();',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.recorder.dependencyPresent).toBe(false);
    expect(draft.recorder.initDetected).toBe(true);
    expect(draft.plan.alreadyInstrumented).toBe(false);
  });

  it('detects a CSP meta tag and recommends adding the ingest origin', () => {
    const dir = makeRepo({
      'index.html':
        '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head></html>',
    });
    const draft = collectRumSetupDraft(dir, { ingestOrigin: 'https://hub.example.com' });
    expect(draft.cspHits).toEqual([{ path: 'index.html', source: 'meta' }]);
    expect(draft.plan.recommendedConnectSrc).toBe('https://hub.example.com');
    expect(draft.plan.notes.some((n) => n.includes('connect-src https://hub.example.com'))).toBe(
      true,
    );
  });

  it('detects a CSP response header in config as source=header', () => {
    const dir = makeRepo({
      'package.json': pkg({ next: '14.0.0' }),
      'next.config.js':
        'module.exports = { headers: async () => [{ headers: [{ key: "Content-Security-Policy", value: "default-src \'self\'" }] }] }',
    });
    const draft = collectRumSetupDraft(dir);
    expect(draft.cspHits).toEqual([{ path: 'next.config.js', source: 'header' }]);
  });

  it('defaults recommendedConnectSrc to a placeholder when no origin is supplied', () => {
    const dir = makeRepo({ 'index.html': '<!doctype html><html></html>' });
    expect(collectRumSetupDraft(dir).plan.recommendedConnectSrc).toBe('${AGENT_HUB_URL}');
  });
});
