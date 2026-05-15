import { describe, expect, it } from 'vitest';

import { computeCiPlan, formatGithubOutput } from '../scripts/ci-path-plan.mjs';

describe('computeCiPlan', () => {
  it('treats no diffs as docs-only / skip CI legs', () => {
    const p = computeCiPlan({});
    expect(p).toEqual({
      run_lint: false,
      run_terraform: false,
      run_build: false,
      run_tests: false,
      test_matrix: { include: [] },
    });
  });

  it('runs terraform only when ops/terraform changes', () => {
    expect(computeCiPlan({ terraform: 'true' })).toMatchObject({
      run_terraform: true,
      run_lint: false,
      run_build: false,
      run_tests: false,
    });
  });

  it('runs server tests and lint when server/** changes', () => {
    const p = computeCiPlan({ server: 'true' });
    expect(p.run_lint).toBe(true);
    expect(p.run_build).toBe(false);
    expect(p.run_tests).toBe(true);
    expect(p.test_matrix.include.filter((r) => r.suite === 'server')).toHaveLength(3);
    expect(p.test_matrix.include.some((r) => r.suite === 'client')).toBe(false);
  });

  it('runs client build + tests when shared/** changes', () => {
    const p = computeCiPlan({ shared: 'true' });
    expect(p.run_lint).toBe(true);
    expect(p.run_build).toBe(true);
    expect(p.run_tests).toBe(true);
    expect(p.test_matrix.include.some((r) => r.suite === 'client')).toBe(true);
    expect(p.test_matrix.include.some((r) => r.suite === 'server')).toBe(false);
  });

  it('runs mobile tests without lint when only mobile app paths change', () => {
    const p = computeCiPlan({ mobile: 'true' });
    expect(p.run_lint).toBe(false);
    expect(p.run_build).toBe(false);
    expect(p.run_tests).toBe(true);
    expect(p.test_matrix.include).toEqual([{ suite: 'mobile', label: 'mobile' }]);
  });

  it('global / lockfile bumps run everything', () => {
    const p = computeCiPlan({ global: 'true' });
    expect(p.run_lint).toBe(true);
    expect(p.run_build).toBe(true);
    expect(p.run_tests).toBe(true);
    expect(p.test_matrix.include).toHaveLength(6);
  });

  it('formatGithubOutput uses MATRIX_EOF delimiter', () => {
    const p = computeCiPlan({ client: 'true' });
    const out = formatGithubOutput(p);
    expect(out).toContain('test_matrix<<MATRIX_EOF');
    expect(out).toContain('MATRIX_EOF');
    expect(out).toContain('"suite":"client"');
  });
});
