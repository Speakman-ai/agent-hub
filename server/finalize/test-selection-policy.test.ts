import {
  DEFAULT_FULL_RUN_PATHS,
  fullRunPathHits,
  parseTestSelectionPatch,
  resolveTestSelectionPolicy,
} from './test-selection-policy.js';
import { DEFAULT_BASE_DRIFT_HAZARD_PATHS } from './base-drift-policy.js';

describe('resolveTestSelectionPolicy', () => {
  it('defaults to full with the built-in fullRunPaths', () => {
    expect(resolveTestSelectionPolicy(undefined)).toEqual({
      mode: 'full',
      alwaysRun: [],
      fullRunPaths: [...DEFAULT_FULL_RUN_PATHS],
    });
    expect(resolveTestSelectionPolicy(null).mode).toBe('full');
  });

  it('includes every base-drift hazard path in the defaults', () => {
    for (const glob of DEFAULT_BASE_DRIFT_HAZARD_PATHS) {
      expect(DEFAULT_FULL_RUN_PATHS).toContain(glob);
    }
  });

  it('reads an unknown mode as full', () => {
    expect(resolveTestSelectionPolicy({ mode: 'smart' as never }).mode).toBe('full');
    expect(resolveTestSelectionPolicy({ mode: 'dynamic' }).mode).toBe('dynamic');
  });

  it('adds project globs to the defaults without duplicates', () => {
    const policy = resolveTestSelectionPolicy({
      fullRunPaths: ['proto/**', '**/package.json', ' proto/** '],
      alwaysRun: ['lint', '', 'lint', 'build'],
    });
    expect(policy.fullRunPaths).toEqual([...DEFAULT_FULL_RUN_PATHS, 'proto/**']);
    expect(policy.alwaysRun).toEqual(['lint', 'build']);
  });

  it('default globs force a full run for each ecosystem', () => {
    const policy = resolveTestSelectionPolicy({});
    const forcing = [
      'package-lock.json',
      'server/package.json',
      'client/vitest.config.ts',
      'e2e/playwright.config.ts',
      'poetry.lock',
      'requirements-dev.txt',
      'tests/conftest.py',
      'pytest.ini',
      'Gemfile.lock',
      '.rspec',
      'go.sum',
      'svc/go.mod',
      'Cargo.lock',
      'crates/a/Cargo.toml',
      '.agent-hub/ci.yaml',
      'server/Dockerfile.dev',
      'docker-compose.test.yml',
      'app/migrations/0042_add.py',
      'db/migrate/20260101_add.rb',
    ];
    const notForcing = ['server/index.ts', 'README.md', 'client/src/App.test.tsx'];
    expect(fullRunPathHits([...forcing, ...notForcing], policy)).toEqual([...forcing].sort());
  });

  it('project globs match alongside the defaults', () => {
    const policy = resolveTestSelectionPolicy({ fullRunPaths: ['proto/**'] });
    expect(fullRunPathHits(['proto/a.proto', 'yarn.lock', 'src/a.ts'], policy)).toEqual([
      'proto/a.proto',
      'yarn.lock',
    ]);
  });
});

describe('parseTestSelectionPatch', () => {
  it('accepts null and partial objects', () => {
    expect(parseTestSelectionPatch(null)).toEqual({ ok: true, value: null });
    expect(parseTestSelectionPatch({ mode: 'dynamic' })).toEqual({
      ok: true,
      value: { mode: 'dynamic' },
    });
  });

  it('rejects bad shapes', () => {
    expect(parseTestSelectionPatch([]).ok).toBe(false);
    expect(parseTestSelectionPatch({ mode: 'smart' }).ok).toBe(false);
    expect(parseTestSelectionPatch({ alwaysRun: [1] }).ok).toBe(false);
    expect(parseTestSelectionPatch({ fullRunPaths: 'x' }).ok).toBe(false);
  });
});
