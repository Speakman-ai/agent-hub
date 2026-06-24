import { describe, it, expect } from 'vitest';
import { isRunnerCancellationCollateral } from './step-cancellation.js';

describe('isRunnerCancellationCollateral', () => {
  describe('matches runner-cancellation collateral', () => {
    it('bare Go context-canceled error as the terminal line', () => {
      expect(isRunnerCancellationCollateral({ tail: ['Running tests…', 'context canceled'] })).toBe(
        true,
      );
    });

    it('British double-L spelling', () => {
      expect(isRunnerCancellationCollateral({ tail: ['context cancelled'] })).toBe(true);
    });

    it('context deadline exceeded corroborated by a daemon-loss marker (Rule 1)', () => {
      // A deadline is collateral ONLY when an unmistakable daemon-loss marker
      // disambiguates it from an ordinary operation timeout.
      expect(
        isRunnerCancellationCollateral({
          tail: [
            'error during connect: Get "http://docker.sock/v1.45/info": context deadline exceeded',
            'make: *** [e2e] Error 1',
          ],
        }),
      ).toBe(true);
    });

    it('terminal line with an ERROR: prefix', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: ['Step 3/3 : RUN make', 'ERROR: context canceled'],
        }),
      ).toBe(true);
    });

    it('docker daemon connection lost mid-command (error during connect)', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: [
            'error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.45/containers/json": context canceled',
            'make: *** [test] Error 1',
          ],
        }),
      ).toBe(true);
    });

    it('Cannot connect to the Docker daemon + a cancel phrase anywhere in scope', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock.', 'exit 1'],
          excerpt: ['compose up failed: context canceled'],
        }),
      ).toBe(true);
    });
  });

  describe('wrapped non-Docker tools (kubectl / gh / Go CLIs under make/npm)', () => {
    it('bare context-canceled then a trailing `make: *** Error 1`', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: ['context canceled', 'make: *** [test] Error 1'],
        }),
      ).toBe(true);
    });

    it('kubectl error-chain ending in context canceled, wrapped by make', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: [
            'Unable to connect to the server: context canceled',
            'make[1]: *** [e2e] Error 2',
            'make: *** [ci] Error 2',
          ],
        }),
      ).toBe(true);
    });

    it('gh error-chain ending in context canceled, wrapped by npm', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: [
            'gh: failed to run git: context canceled',
            'npm ERR! code ELIFECYCLE',
            'npm ERR! errno 1',
          ],
        }),
      ).toBe(true);
    });

    it('shell `set -x` exit trace after the cancellation', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: ['deploy.sh: context canceled', '+ exit 1'],
        }),
      ).toBe(true);
    });
  });

  describe('does NOT match genuine failures', () => {
    it('ordinary test assertion failure', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: ['FAIL src/foo.test.ts', '  expected 1 to equal 2', '1 test failed'],
        }),
      ).toBe(false);
    });

    it('a test that prints "context canceled" mid-run then fails an assertion later', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: [
            'handler logged: context canceled',
            'AssertionError: expected status 200 but got 500',
            '1 failing',
          ],
        }),
      ).toBe(false);
    });

    it('an assertion that ENDS on the words "context canceled" (space-preceded, no colon wrap)', () => {
      // A genuine assertion whose actual value happens to be the cancellation
      // words must stay a real failure — the phrase is space-preceded, not at
      // line-start and not after a `:` error-wrap.
      expect(
        isRunnerCancellationCollateral({
          tail: ['AssertionError: expected ok, got context canceled'],
        }),
      ).toBe(false);
    });

    it('a bare assertion phrase "expected context canceled" does not match', () => {
      expect(isRunnerCancellationCollateral({ tail: ['expected context canceled'] })).toBe(false);
    });

    it('a space-preceded assertion under a make wrapper still does not match', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: ['AssertionError: expected ok, got context canceled', 'make: *** [test] Error 1'],
        }),
      ).toBe(false);
    });

    it('a verbose line that merely mentions the phrase but is not the bare error', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: [
            'expected the request to succeed but it returned "context canceled" which is wrong and should never happen here',
          ],
        }),
      ).toBe(false);
    });

    it('a genuine assertion failure wrapped by make does not match', () => {
      // After stripping the trailing `make: *** Error 1`, the real last line is
      // the assertion — not a cancellation.
      expect(
        isRunnerCancellationCollateral({
          tail: ['AssertionError: expected 200 but got 500', 'make: *** [test] Error 1'],
        }),
      ).toBe(false);
    });

    it('an assertion that quotes "context canceled" then a make error does not match', () => {
      // The phrase is embedded in a quoted value mid-sentence, not the line's
      // tail, so even under make-wrapper noise it stays a genuine failure.
      expect(
        isRunnerCancellationCollateral({
          tail: [
            'assertion failed: got "context canceled" but wanted ok',
            'make: *** [test] Error 1',
          ],
        }),
      ).toBe(false);
    });

    it('output that is ONLY wrapper exit noise (no cancellation) does not match', () => {
      expect(
        isRunnerCancellationCollateral({
          tail: ['1 test failed', 'make: *** [test] Error 1'],
        }),
      ).toBe(false);
    });

    it('a bare "context deadline exceeded" terminal line is a real timeout, not collateral', () => {
      // Regression for PR #255 review: `context.DeadlineExceeded` is what Go CLIs
      // print for an ORDINARY operation/API timeout — a deterministic, fixable
      // step failure. Without a corroborating daemon-loss marker it must NOT be
      // reclassified as runner cancellation, else a real red gets auto-retried
      // as infra noise and eventually surfaces as an infra failure.
      expect(
        isRunnerCancellationCollateral({ tail: ['pulling image…', 'context deadline exceeded'] }),
      ).toBe(false);
    });

    it('a Go error-chain ending in "context deadline exceeded" (no daemon marker) is a real timeout', () => {
      // This colon-wrapped shape WOULD have matched the terminal-line rule before
      // the narrowing; an HTTP/API deadline is a genuine failure, so it stays red.
      expect(
        isRunnerCancellationCollateral({
          tail: ['Get "https://api.example.com/health": context deadline exceeded'],
        }),
      ).toBe(false);
    });

    it('a "context deadline exceeded" terminal line under a make wrapper is still a real timeout', () => {
      // Wrapper noise is stripped first, but the underlying deadline still must
      // not be treated as collateral without daemon-loss corroboration.
      expect(
        isRunnerCancellationCollateral({
          tail: [
            'curl: operation timed out: context deadline exceeded',
            'make: *** [smoke] Error 1',
          ],
        }),
      ).toBe(false);
    });

    it('empty output', () => {
      expect(isRunnerCancellationCollateral({ tail: [] })).toBe(false);
      expect(isRunnerCancellationCollateral({ tail: ['', '  ', '\t'] })).toBe(false);
    });

    it('cancel phrase only in the excerpt, no daemon marker, not the terminal line', () => {
      // Excerpt mention alone must not trip rule 2 (terminal-line) — that rule
      // only consults the tail's last line.
      expect(
        isRunnerCancellationCollateral({
          tail: ['FAIL src/bar.test.ts', 'AssertionError'],
          excerpt: ['some earlier note: context canceled'],
        }),
      ).toBe(false);
    });
  });
});
