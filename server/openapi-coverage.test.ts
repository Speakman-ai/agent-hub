import { describe, it, expect } from 'vitest';

import {
  countHandlers,
  countRegistrations,
  analyzeFile,
  compareWithBaseline,
  type Baseline,
} from './openapi-coverage.js';

describe('openapi-coverage / countHandlers', () => {
  it('counts each verb the router exposes', () => {
    const src = `
      router.get('/a', h);
      router.post('/b', h);
      router.put('/c', h);
      router.delete('/d', h);
      router.patch('/e', h);
    `;
    expect(countHandlers(src)).toBe(5);
  });

  it('tolerates whitespace between the dot and the verb call', () => {
    const src = `
      router.get  ('/spaced', h);
      router.post\t('/tabbed', h);
    `;
    expect(countHandlers(src)).toBe(2);
  });

  it('ignores non-router method calls', () => {
    const src = `
      app.get('/legacy', h);            // not router.*
      thing.router.get('/nested', h);   // method on a different object
      something.use(router);
    `;
    // 'thing.router.get(' DOES contain 'router.get(' so it matches — that's
    // fine, the only place that pattern appears in this codebase is the
    // actual mount.
    expect(countHandlers(src)).toBe(1);
  });

  it('returns 0 for empty source', () => {
    expect(countHandlers('')).toBe(0);
  });
});

describe('openapi-coverage / countRegistrations', () => {
  it('counts registerPath invocations regardless of receiver', () => {
    const src = `
      registry.registerPath({...});
      reg.registerPath({...});
      this.registry.registerPath({...});
    `;
    expect(countRegistrations(src)).toBe(3);
  });

  it('counts bare registerPath() calls from named imports', () => {
    const src = `
      import { registerPath } from '../openapi/registry.js';
      registerPath({...});
      registerPath({...});
    `;
    expect(countRegistrations(src)).toBe(2);
  });

  it('returns 0 when the registry is only imported', () => {
    const src = `
      import { registry } from './openapi/registry.js';
      const x = registry; // not called
    `;
    expect(countRegistrations(src)).toBe(0);
  });

  it('does not double-count the named import itself', () => {
    const src = `
      import { registerPath, registerComponent } from '../openapi/registry.js';
    `;
    // The import statement has no `(`, so the regex must not fire.
    expect(countRegistrations(src)).toBe(0);
  });

  it('rejects identifiers that merely end in registerPath', () => {
    const src = `
      foo_registerPath({...});
      xregisterPath({...});
    `;
    expect(countRegistrations(src)).toBe(0);
  });
});

describe('openapi-coverage / analyzeFile', () => {
  it('sums inline + companion registrations against handlers', () => {
    const routeSrc = `
      router.get('/a', h);
      router.post('/b', h);
      router.put('/c', h);
      registry.registerPath({ method: 'get', path: '/a' });
    `;
    const companion = `
      registry.registerPath({ method: 'post', path: '/b' });
    `;
    const result = analyzeFile('demo', routeSrc, companion);
    expect(result).toEqual({
      name: 'demo',
      handlers: 3,
      inlineRegistrations: 1,
      companionRegistrations: 1,
      totalRegistrations: 2,
      unregistered: 1,
    });
  });

  it('treats null companion as "no companion file"', () => {
    const routeSrc = `router.get('/a', h);`;
    const result = analyzeFile('demo', routeSrc, null);
    expect(result.companionRegistrations).toBeNull();
    expect(result.totalRegistrations).toBe(0);
    expect(result.unregistered).toBe(1);
  });

  it('floors unregistered at 0 when registrations exceed handlers', () => {
    const routeSrc = `router.get('/a', h);`;
    const companion = `
      registry.registerPath({});
      registry.registerPath({});
      registry.registerPath({});
    `;
    const result = analyzeFile('demo', routeSrc, companion);
    expect(result.unregistered).toBe(0);
  });
});

describe('openapi-coverage / compareWithBaseline', () => {
  const baseline: Baseline = {
    'fully-covered': { allowed_unregistered: 0 },
    'in-progress': { allowed_unregistered: 5, note: 'card 1234' },
  };

  it('passes when measurement equals baseline', () => {
    const file = {
      name: 'fully-covered',
      handlers: 3,
      inlineRegistrations: 0,
      companionRegistrations: 3,
      totalRegistrations: 3,
      unregistered: 0,
    };
    const verdict = compareWithBaseline(file, baseline);
    expect(verdict.kind).toBe('ok');
  });

  it('flags new debt as fail (over baseline)', () => {
    const file = {
      name: 'fully-covered',
      handlers: 4,
      inlineRegistrations: 0,
      companionRegistrations: 3,
      totalRegistrations: 3,
      unregistered: 1,
    };
    const verdict = compareWithBaseline(file, baseline);
    expect(verdict.kind).toBe('fail');
    if (verdict.kind === 'fail') {
      expect(verdict.overflow).toBe(1);
      expect(verdict.allowed).toBe(0);
    }
  });

  it('reports slack when contributor reduced debt below baseline', () => {
    const file = {
      name: 'in-progress',
      handlers: 6,
      inlineRegistrations: 4,
      companionRegistrations: null,
      totalRegistrations: 4,
      unregistered: 2,
    };
    const verdict = compareWithBaseline(file, baseline);
    expect(verdict.kind).toBe('slack');
    if (verdict.kind === 'slack') {
      expect(verdict.surplus).toBe(3); // baseline=5, actual=2
    }
  });

  it('defaults missing baseline entries to 0 allowed (new files must be fully migrated)', () => {
    const file = {
      name: 'never-seen',
      handlers: 1,
      inlineRegistrations: 0,
      companionRegistrations: null,
      totalRegistrations: 0,
      unregistered: 1,
    };
    const verdict = compareWithBaseline(file, baseline);
    expect(verdict.kind).toBe('fail');
    if (verdict.kind === 'fail') {
      expect(verdict.allowed).toBe(0);
      expect(verdict.overflow).toBe(1);
    }
  });

  it('treats baseline-with-debt + zero-handlers as slack (file emptied)', () => {
    const file = {
      name: 'in-progress',
      handlers: 0,
      inlineRegistrations: 0,
      companionRegistrations: null,
      totalRegistrations: 0,
      unregistered: 0,
    };
    const verdict = compareWithBaseline(file, baseline);
    expect(verdict.kind).toBe('slack');
  });
});
