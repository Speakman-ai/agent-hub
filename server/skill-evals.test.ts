import { describe, it, expect } from 'vitest';
import { parseEvals, serializeEvals, gradeOutput, MAX_EVALS_PER_SKILL } from './skill-evals.js';

describe('parseEvals', () => {
  it('accepts a wrapped { evals: [...] } payload', () => {
    const res = parseEvals({ evals: [{ id: 'a', prompt: 'do thing' }] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.evals).toEqual([{ id: 'a', prompt: 'do thing' }]);
  });

  it('accepts a bare array payload', () => {
    const res = parseEvals([{ id: 'a', prompt: 'x' }]);
    expect(res.ok).toBe(true);
  });

  it('trims and keeps assertions', () => {
    const res = parseEvals({
      evals: [
        {
          id: 'happy',
          prompt: '  run the tests  ',
          assertions: [{ type: 'contains', value: 'vitest' }],
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.evals[0].prompt).toBe('run the tests');
      expect(res.evals[0].assertions).toEqual([{ type: 'contains', value: 'vitest' }]);
    }
  });

  it('rejects a missing evals array', () => {
    const res = parseEvals({});
    expect(res).toEqual({ ok: false, error: 'missing "evals" array' });
  });

  it('rejects an empty suite', () => {
    const res = parseEvals({ evals: [] });
    expect(res.ok).toBe(false);
  });

  it('rejects non-slug ids', () => {
    const res = parseEvals({ evals: [{ id: 'Has Spaces', prompt: 'x' }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/slug/);
  });

  it('rejects duplicate ids', () => {
    const res = parseEvals({
      evals: [
        { id: 'a', prompt: 'x' },
        { id: 'a', prompt: 'y' },
      ],
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/duplicate/);
  });

  it('rejects a missing prompt', () => {
    const res = parseEvals({ evals: [{ id: 'a', prompt: '   ' }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/prompt is required/);
  });

  it('rejects an unknown assertion type', () => {
    const res = parseEvals({
      evals: [{ id: 'a', prompt: 'x', assertions: [{ type: 'matches', value: 'y' }] }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/type must be one of/);
  });

  it('rejects an empty assertion value', () => {
    const res = parseEvals({
      evals: [{ id: 'a', prompt: 'x', assertions: [{ type: 'contains', value: '' }] }],
    });
    expect(res.ok).toBe(false);
  });

  it('rejects an invalid regex at parse time (so grading never throws)', () => {
    const res = parseEvals({
      evals: [{ id: 'a', prompt: 'x', assertions: [{ type: 'regex', value: '([' }] }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/valid regular expression/);
  });

  it('drops an empty assertions array to undefined (subjective)', () => {
    const res = parseEvals({ evals: [{ id: 'a', prompt: 'x', assertions: [] }] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.evals[0].assertions).toBeUndefined();
  });

  it('caps the number of evals', () => {
    const evals = Array.from({ length: MAX_EVALS_PER_SKILL + 1 }, (_, i) => ({
      id: `e${i}`,
      prompt: 'x',
    }));
    const res = parseEvals({ evals });
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown field inside an eval (typo guard, e.g. "assertion")', () => {
    const res = parseEvals({
      evals: [{ id: 'a', prompt: 'x', assertion: [{ type: 'contains', value: 'y' }] }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown field "assertion"/);
  });

  it('rejects an unknown field inside an assertion (e.g. "pattern")', () => {
    const res = parseEvals({
      evals: [{ id: 'a', prompt: 'x', assertions: [{ type: 'regex', pattern: 'y' }] }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown field "pattern"/);
  });

  it('rejects an unknown top-level key but still allows "version"', () => {
    expect(parseEvals({ version: 1, evals: [{ id: 'a', prompt: 'x' }] }).ok).toBe(true);
    const res = parseEvals({ evals: [{ id: 'a', prompt: 'x' }], extra: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown field "extra"/);
  });

  it('round-trips through serialize → parse', () => {
    const evals = [
      { id: 'a', prompt: 'x', assertions: [{ type: 'icontains' as const, value: 'Yes' }] },
      { id: 'b', prompt: 'y' },
    ];
    const text = serializeEvals(evals);
    expect(text.endsWith('\n')).toBe(true);
    const back = parseEvals(JSON.parse(text));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.evals).toEqual(evals);
  });
});

describe('gradeOutput', () => {
  it('returns ungraded for subjective evals', async () => {
    const g = await gradeOutput('whatever', undefined);
    expect(g).toEqual({ graded: false, passed: false, assertionResults: [] });
  });

  it('passes when every assertion passes', async () => {
    const g = await gradeOutput('use cd server && npx vitest foo.test.ts', [
      { type: 'contains', value: 'npx vitest' },
      { type: 'not_contains', value: 'npm test' },
    ]);
    expect(g.graded).toBe(true);
    expect(g.passed).toBe(true);
    expect(g.assertionResults.every((r) => r.passed)).toBe(true);
  });

  it('fails when one assertion fails and reports which', async () => {
    const g = await gradeOutput('just run npm test', [
      { type: 'contains', value: 'npx vitest' },
      { type: 'not_contains', value: 'npm test' },
    ]);
    expect(g.passed).toBe(false);
    expect(g.assertionResults.map((r) => r.passed)).toEqual([false, false]);
  });

  it('icontains is case-insensitive; contains is not', async () => {
    expect((await gradeOutput('YES it works', [{ type: 'icontains', value: 'yes' }])).passed).toBe(
      true,
    );
    expect((await gradeOutput('YES it works', [{ type: 'contains', value: 'yes' }])).passed).toBe(
      false,
    );
  });

  it('regex matches against the output (and does not flag a timeout on a fast pattern)', async () => {
    expect(
      (await gradeOutput('exit code 0', [{ type: 'regex', value: 'exit code \\d' }])).passed,
    ).toBe(true);
    const miss = await gradeOutput('done', [{ type: 'regex', value: '^never$' }]);
    expect(miss.passed).toBe(false);
    expect(miss.assertionResults[0].timedOut).toBeUndefined();
  });

  it('grades a mix of substring + regex assertions in order', async () => {
    const g = await gradeOutput('exit code 0 — all good', [
      { type: 'contains', value: 'all good' },
      { type: 'regex', value: 'exit code \\d' },
      { type: 'not_contains', value: 'FAIL' },
    ]);
    expect(g.passed).toBe(true);
    expect(g.assertionResults.map((r) => r.assertion.type)).toEqual([
      'contains',
      'regex',
      'not_contains',
    ]);
  });

  it('bounds a catastrophic (ReDoS) regex instead of hanging the event loop', async () => {
    // `(a+)+$` backtracks exponentially against a long non-matching input. The
    // grader must return with a timed-out, failed assertion rather than block —
    // the worker is force-terminated at the budget. A fast substring assertion
    // alongside it must still grade correctly (worker streams partial results).
    const start = Date.now();
    const g = await gradeOutput('a'.repeat(50) + '!', [
      { type: 'contains', value: 'a' },
      { type: 'regex', value: '(a+)+$' },
    ]);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(g.assertionResults[0].passed).toBe(true); // substring, resolved inline
    expect(g.assertionResults[1].passed).toBe(false); // regex, terminated
    expect(g.assertionResults[1].timedOut).toBe(true);
    expect(g.passed).toBe(false);
  });
});
