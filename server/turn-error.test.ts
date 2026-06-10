import { describe, it, expect } from 'vitest';
import {
  resolveTurnEndError,
  isTransientTurnError,
  planTransientErrorRetry,
  buildTurnErrorContinuationPrompt,
  buildTransientRetryNotice,
  buildTurnErrorHaltNotice,
  TRANSIENT_TURN_ERROR_MAX_RETRIES,
} from './turn-error.js';

describe('resolveTurnEndError', () => {
  it('returns null for a clean close', () => {
    expect(
      resolveTurnEndError({
        exitCode: 0,
        signal: null,
        streamErrorMessage: '',
        engine: 'claude-code',
      }),
    ).toBeNull();
  });

  // Regression: the screenshot bug — assistant text streamed, then the
  // upstream socket dropped. The CLI emitted an isError result event and the
  // turn must classify as errored even though exit-code handling alone would
  // have been enough; the stream text is the preferred message.
  it('flags a stream error even when present alongside exit 0', () => {
    const err = resolveTurnEndError({
      exitCode: 0,
      signal: null,
      streamErrorMessage: 'API Error: The socket connection was closed unexpectedly',
      engine: 'claude-code',
    });
    expect(err?.errorText).toBe('API Error: The socket connection was closed unexpectedly');
  });

  it('prefers stream error text over the exit-code fallback', () => {
    const err = resolveTurnEndError({
      exitCode: 1,
      signal: null,
      streamErrorMessage: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      engine: 'claude-code',
    });
    expect(err?.errorText).toContain('overloaded_error');
  });

  it('falls back to exit-code text when no stream error was captured', () => {
    const err = resolveTurnEndError({
      exitCode: 1,
      signal: null,
      streamErrorMessage: '',
      engine: 'codex-cli',
    });
    expect(err?.errorText).toBe('codex-cli exited with code 1');
  });

  it('flags a signal kill (code null) as an error', () => {
    const err = resolveTurnEndError({
      exitCode: null,
      signal: 'SIGKILL',
      streamErrorMessage: '',
      engine: 'claude-code',
    });
    expect(err?.errorText).toBe('claude-code terminated by signal SIGKILL');
  });

  it('treats whitespace-only stream error as absent', () => {
    expect(
      resolveTurnEndError({ exitCode: 0, signal: null, streamErrorMessage: '   ', engine: 'x' }),
    ).toBeNull();
  });
});

describe('isTransientTurnError', () => {
  it.each([
    'API Error: The socket connection was closed unexpectedly',
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    'API Error: 503 Service Unavailable',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    'fetch failed',
    'read ECONNRESET',
    'connect ETIMEDOUT 160.79.104.10:443',
    'socket hang up',
    'stream ended unexpectedly',
    'Request timed out',
  ])('classifies %s as transient', (text) => {
    expect(isTransientTurnError(text)).toBe(true);
  });

  it.each([
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    'Credit balance is too low to access the Anthropic API',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}',
    'Reached max turns (50)',
    'invalid x-api-key',
    'claude-code exited with code 1',
    '',
  ])('classifies %s as NOT transient', (text) => {
    expect(isTransientTurnError(text)).toBe(false);
  });

  // Non-transient patterns must win even when a transient keyword co-occurs:
  // a 401 mentioning "connection" must not be retried.
  it('non-transient patterns take precedence', () => {
    expect(isTransientTurnError('401 unauthorized: connection closed by server')).toBe(false);
  });
});

describe('planTransientErrorRetry', () => {
  const SOCKET = 'API Error: The socket connection was closed unexpectedly';

  it('retries a transient error with backoff', () => {
    expect(planTransientErrorRetry(0, SOCKET)).toEqual({ retry: true, delayMs: 2_000 });
    expect(planTransientErrorRetry(1, SOCKET)).toEqual({ retry: true, delayMs: 10_000 });
  });

  it('stops at the retry cap', () => {
    expect(planTransientErrorRetry(TRANSIENT_TURN_ERROR_MAX_RETRIES, SOCKET)).toEqual({
      retry: false,
      delayMs: 0,
    });
  });

  it('never retries a non-transient error', () => {
    expect(planTransientErrorRetry(0, 'Credit balance is too low')).toEqual({
      retry: false,
      delayMs: 0,
    });
  });
});

describe('notice/prompt builders', () => {
  it('continuation prompt carries the error and a verify instruction', () => {
    const p = buildTurnErrorContinuationPrompt('API Error: socket closed');
    expect(p).toContain('API Error: socket closed');
    expect(p).toMatch(/verify/i);
    expect(p).toMatch(/resume/i);
  });

  it('retry notice states attempt count and finalize pause', () => {
    const n = buildTransientRetryNotice('boom', 1, 2_000);
    expect(n).toContain(`attempt 1/${TRANSIENT_TURN_ERROR_MAX_RETRIES}`);
    expect(n).toMatch(/finalize automation is paused/i);
  });

  it('halt notice distinguishes exhausted retries from non-retryable errors', () => {
    expect(buildTurnErrorHaltNotice('boom', 2)).toMatch(/gave up after 2 attempts/i);
    expect(buildTurnErrorHaltNotice('boom', 0)).toMatch(/not auto-retryable/i);
  });
});
