/**
 * Unit tests for the runner-teardown detector — the single source of truth
 * that distinguishes a Finalize runner torn down mid `docker exec` (Go
 * `context canceled`, every test green) from a genuine test/build failure.
 *
 * The detector gates an auto-retry (Layer A) and a fix-dispatch hint (Layer
 * B), so the critical contracts are:
 *   - a clean teardown (sentinel + no failure summary)            → true
 *   - a real red that ALSO logged `context canceled`             → false
 *   - prose that merely mentions "context canceled"              → false
 */
import { describe, expect, it } from 'vitest';

import {
  isRunnerTeardownExit,
  looksLikeRunnerTeardownForHint,
  RUNNER_TEARDOWN_DISPATCH_HINT,
  RUNNER_TEARDOWN_SENTINEL_RE,
  TEST_FAILURE_SUMMARY_RE,
} from './runner-teardown.js';

const ESC = String.fromCharCode(27);
/** Wrap text in an SGR color code the way vitest/jest colorise output. */
const color = (code: number, s: string) => `${ESC}[${code}m${s}${ESC}[39m`;

describe('isRunnerTeardownExit', () => {
  it('flags a clean teardown: context-canceled terminal line, all tests green', () => {
    const outputTail = [
      color(32, '✓') + ' src/components/MyCodexAuthSection.test.tsx (4 tests) 3204ms',
      '     ✓ stops polling once uiStatus=authenticated 3024ms',
      'context canceled',
    ];
    expect(isRunnerTeardownExit({ outputTail, failureExcerpt: [] })).toBe(true);
  });

  it('does NOT flag a real failure that also ends in context canceled (stays CI-class)', () => {
    const outputTail = [
      color(31, 'FAIL') + ' src/components/Foo.test.tsx',
      'Tests  3 failed | 900 passed (903)',
      'context canceled',
    ];
    // The failure summary in the tail wins — a torn-down red is still red.
    expect(isRunnerTeardownExit({ outputTail, failureExcerpt: [] })).toBe(false);
  });

  it('does NOT flag when the failure summary is in the excerpt, not the tail', () => {
    const failureExcerpt = [
      '  1) renders the banner',
      '     AssertionError: expected 1 to equal 2',
    ];
    const outputTail = ['some trailing noise', 'context canceled'];
    expect(isRunnerTeardownExit({ outputTail, failureExcerpt })).toBe(false);
  });

  it('treats benign console.error("…Error…") lines from PASSING tests as non-failure', () => {
    // These are exactly the lines that make FAILURE_SIGNAL_RE useless as a
    // teardown discriminator — passing error-handling tests log them.
    const outputTail = [
      'Failed to load skills: Error: 500 Internal Server Error',
      color(32, '✓') + ' src/components/SkillsPage.test.tsx (12 tests) 300ms',
      'context canceled',
    ];
    const failureExcerpt = ['Failed to load skills: Error: 500 Internal Server Error'];
    expect(isRunnerTeardownExit({ outputTail, failureExcerpt })).toBe(true);
  });

  it('does NOT flag when there is no context-canceled sentinel at all', () => {
    const outputTail = [color(32, '✓') + ' all good', 'Test Files  51 passed (51)'];
    expect(isRunnerTeardownExit({ outputTail, failureExcerpt: [] })).toBe(false);
  });

  it('does NOT flag prose that merely mentions context canceled mid-stream', () => {
    // Sentinel is anchored to the whole line AND must be terminal; a phrase
    // buried in a log line followed by more output is not a teardown.
    const outputTail = [
      'note: the upstream returned context canceled earlier but we retried',
      color(32, '✓') + ' recovered (1 test)',
      'Test Files  1 passed (1)',
    ];
    expect(isRunnerTeardownExit({ outputTail, failureExcerpt: [] })).toBe(false);
  });

  it('does NOT flag when the sentinel is too far from the terminal window', () => {
    const outputTail = [
      'context canceled',
      'line +1',
      'line +2',
      'line +3',
      color(32, '✓') + ' something ran after',
    ];
    // Strict (Layer A) rejects it — the sentinel is outside the terminal
    // window — but the BROAD (Layer B) predicate still flags it, which is the
    // whole point of Layer B: catch teardowns the strict detector misses.
    expect(isRunnerTeardownExit({ outputTail, failureExcerpt: [] })).toBe(false);
    expect(looksLikeRunnerTeardownForHint({ outputTail, failureExcerpt: [] })).toBe(true);
  });

  it('tolerates a trailing status line the runner-agent appends after docker', () => {
    const outputTail = [
      color(32, '✓') + ' last test (1 test)',
      'context canceled',
      'runner: lease released',
    ];
    expect(isRunnerTeardownExit({ outputTail, failureExcerpt: [] })).toBe(true);
  });

  it('returns false on empty / whitespace-only output', () => {
    expect(isRunnerTeardownExit({ outputTail: [], failureExcerpt: [] })).toBe(false);
    expect(isRunnerTeardownExit({ outputTail: ['', '   '], failureExcerpt: [] })).toBe(false);
    expect(isRunnerTeardownExit({})).toBe(false);
  });

  it('does NOT flag a tsc type error that ends in context canceled', () => {
    const outputTail = ['src/x.ts(7,3): error TS2304: Cannot find name "Foo".', 'context canceled'];
    expect(isRunnerTeardownExit({ outputTail, failureExcerpt: [] })).toBe(false);
  });
});

describe('looksLikeRunnerTeardownForHint (Layer B — broad)', () => {
  it('flags a teardown whose sentinel sits outside the strict terminal window', () => {
    // The runner-agent appended several epilogue lines after docker's sentinel,
    // pushing it out of Layer A's 3-line window. Layer A reclassifies nothing
    // here (the step lands as a `failure`), so the dispatch-side hint is the
    // only thing that can flag it — and it must.
    const outputTail = [
      color(32, '✓') + ' last test (1 test)',
      'context canceled',
      'runner: stopping inner dockerd',
      'runner: removing graph volume',
      'runner: lease released',
      'runner: agent exiting',
    ];
    expect(isRunnerTeardownExit({ outputTail, failureExcerpt: [] })).toBe(false);
    expect(looksLikeRunnerTeardownForHint({ outputTail, failureExcerpt: [] })).toBe(true);
  });

  it('still refuses to flag a genuine red that also logged context canceled', () => {
    const outputTail = [
      color(31, 'FAIL') + ' src/components/Foo.test.tsx',
      'Tests  3 failed | 900 passed (903)',
      'context canceled',
      'runner: lease released',
    ];
    expect(looksLikeRunnerTeardownForHint({ outputTail, failureExcerpt: [] })).toBe(false);
  });

  it('honours the shared failure-summary guardrail when the marker is only in the excerpt', () => {
    // The mocha numbered-failure block (`1) ...`) is a TEST_FAILURE_SUMMARY
    // marker, and it lives in the excerpt rather than the tail. Both layers
    // scan the excerpt too, so the hint is correctly withheld.
    const failureExcerpt = [
      '  1) renders the banner',
      '     AssertionError: expected 1 to equal 2',
    ];
    const outputTail = ['context canceled'];
    expect(looksLikeRunnerTeardownForHint({ outputTail, failureExcerpt })).toBe(false);
  });

  it('does not flag prose mentions or sentinel-free output', () => {
    expect(
      looksLikeRunnerTeardownForHint({
        outputTail: ['the upstream returned context canceled earlier but we retried', 'all good'],
        failureExcerpt: [],
      }),
    ).toBe(false);
    expect(
      looksLikeRunnerTeardownForHint({ outputTail: ['Test Files 1 passed'], failureExcerpt: [] }),
    ).toBe(false);
    expect(looksLikeRunnerTeardownForHint({})).toBe(false);
  });
});

describe('runner-teardown regexes', () => {
  it('sentinel matches only the exact Go context.Canceled string', () => {
    expect(RUNNER_TEARDOWN_SENTINEL_RE.test('context canceled')).toBe(true);
    expect(RUNNER_TEARDOWN_SENTINEL_RE.test('context cancelled')).toBe(false); // British spelling is not Go's
    expect(RUNNER_TEARDOWN_SENTINEL_RE.test('Error: context canceled')).toBe(false);
  });

  it('failure-summary matches real reds but not benign Error lines', () => {
    expect(TEST_FAILURE_SUMMARY_RE.test('Tests  3 failed | 900 passed')).toBe(true);
    expect(TEST_FAILURE_SUMMARY_RE.test('1 failing')).toBe(true);
    expect(TEST_FAILURE_SUMMARY_RE.test('FAIL src/a.test.ts')).toBe(true);
    expect(TEST_FAILURE_SUMMARY_RE.test('error TS2304: Cannot find name')).toBe(true);
    expect(TEST_FAILURE_SUMMARY_RE.test('Failed to load skills: Error: 500')).toBe(false);
    expect(TEST_FAILURE_SUMMARY_RE.test('renders the failed state')).toBe(false);
  });
});

describe('RUNNER_TEARDOWN_DISPATCH_HINT', () => {
  it('tells the agent it is a runner teardown and not to attempt a code fix', () => {
    expect(RUNNER_TEARDOWN_DISPATCH_HINT).toMatch(/context canceled/);
    expect(RUNNER_TEARDOWN_DISPATCH_HINT).toMatch(/do NOT attempt a code fix/i);
  });
});
