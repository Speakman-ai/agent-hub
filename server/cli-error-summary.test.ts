import { describe, it, expect } from 'vitest';
import { summarizeCliError } from './cli-error-summary.js';

// The real stderr blob captured from a scheduled Memory Reconciliation run
// that fell back to gemini-cli and hit a free-tier quota 429. This is the
// regression fixture: before the fix the whole thing (stack frames + the
// `[object Object]` line) was dumped at console.error.
const GEMINI_429_BLOB = `Warning: 256-color support not detected. Using a terminal with at least 256-color support is recommended for a better visual experience.
Error when talking to Gemini API Full report available at: /tmp/gemini-client-error-Turn.run-sendMessageStream-2026-06-09T14-03-52-223Z.json
TerminalQuotaError: You have exhausted your daily quota on this model.
    at classifyGoogleError (file:///usr/local/lib/node_modules/@google/gemini-cli/bundle/chunk-LSXUKR6W.js:304186:16)
    at retryWithBackoff (file:///usr/local/lib/node_modules/@google/gemini-cli/bundle/chunk-LSXUKR6W.js:304871:31)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
{ cause: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.' } }
An unexpected critical error occurred:[object Object]`;

describe('summarizeCliError', () => {
  describe('rate limit / quota', () => {
    it('classifies the real gemini 429 blob as rate_limit with a concise single-line message', () => {
      const { kind, message } = summarizeCliError(GEMINI_429_BLOB, 'gemini-cli');
      expect(kind).toBe('rate_limit');
      // Concise, single line — no stack frames, no [object Object], no noise.
      expect(message).not.toContain('\n');
      expect(message).not.toContain('[object Object]');
      expect(message).not.toMatch(/\bat\s+classifyGoogleError/);
      expect(message).not.toContain('256-color');
      expect(message).toContain('429');
      expect(message).toContain('gemini-cli');
    });

    it.each([
      'code: 429',
      'HTTP status 429 returned',
      'RESOURCE_EXHAUSTED',
      'You exceeded your current quota',
      'Quota exceeded for metric: generativelanguage',
      'Error: rate limit reached for this model',
      'Too Many Requests',
    ])('treats %j as rate_limit', (raw) => {
      expect(summarizeCliError(raw).kind).toBe('rate_limit');
    });

    it('omits the engine prefix when no engine is given', () => {
      const { message } = summarizeCliError('429 Too Many Requests');
      expect(message).not.toMatch(/^\s/);
      expect(message.toLowerCase()).toContain('quota/rate limit');
    });
  });

  describe('auth', () => {
    it.each([
      'Error: Unauthorized',
      'authentication failed',
      'API key not valid',
      'permission denied',
      'claude-code:no-credentials',
      'status 401',
    ])('classifies %j as auth', (raw) => {
      expect(summarizeCliError(raw).kind).toBe('auth');
    });
  });

  describe('other kinds', () => {
    it('classifies timeouts', () => {
      expect(summarizeCliError('Timed out after 3 minutes').kind).toBe('timeout');
    });

    it('classifies missing binary / cwd', () => {
      expect(summarizeCliError('Binary for engine "claude-code" not found at "/x"').kind).toBe(
        'not_found',
      );
      expect(summarizeCliError('spawn ENOENT').kind).toBe('not_found');
    });

    it('falls back to generic and picks the first signal (non-noise) line', () => {
      const raw = [
        'Warning: 256-color support not detected. ...',
        '    at someFrame (foo.js:1:1)',
        'Boom: the model returned a 500',
      ].join('\n');
      const { kind, message } = summarizeCliError(raw);
      expect(kind).toBe('generic');
      expect(message).toBe('Boom: the model returned a 500');
    });

    it('handles empty / nullish input without throwing', () => {
      expect(summarizeCliError(null)).toEqual({ kind: 'generic', message: 'unknown CLI failure' });
      expect(summarizeCliError('')).toEqual({ kind: 'generic', message: 'unknown CLI failure' });
      expect(summarizeCliError('   \n  ')).toEqual({
        kind: 'generic',
        message: 'unknown CLI failure',
      });
    });

    it('clamps a runaway single line to a bounded length', () => {
      const { message } = summarizeCliError('x'.repeat(5000));
      expect(message.length).toBeLessThanOrEqual(240);
      expect(message.endsWith('…')).toBe(true);
    });
  });
});
