// Unit tests for the error-message picker used by chat.ts's close handler.
//
// Regression context:
//   Session "Codex not working" → users saw error messages like
//     "⚠️ Error: Reading additional input from stdin..."
//   because stderr contained only that informational noise, and the close
//   handler used `errorOutput.trim() || ...`. The REAL upstream 400
//   ("The 'gpt-5-codex' model is not supported when using Codex with a
//   ChatGPT account.") was being streamed on stdout as a JSONL
//   `turn.failed` event and dropped. These tests lock the precedence:
//   meaningful stderr > streamErrorMessage > generic exit-code fallback.

import { describe, it, expect } from 'vitest';
import { pickProcessErrorMessage, stripStderrNoise } from './process-error-message.js';

describe('stripStderrNoise', () => {
  it('removes the Codex "Reading additional input" informational line', () => {
    expect(stripStderrNoise('Reading additional input from stdin...\n')).toBe('');
  });

  it('removes the noise even when it is sandwiched between real errors', () => {
    const input = 'Reading additional input from stdin...\nsome real error line\nanother error\n';
    expect(stripStderrNoise(input)).toBe('some real error line\nanother error');
  });

  it('leaves a stderr without noise untouched (modulo trim)', () => {
    expect(stripStderrNoise('  boom\n')).toBe('boom');
  });

  it('returns empty string for empty input', () => {
    expect(stripStderrNoise('')).toBe('');
  });
});

describe('pickProcessErrorMessage', () => {
  const base = { engine: 'codex-cli', exitCode: 1 as number | null };

  it('prefers meaningful stderr over streamErrorMessage', () => {
    const msg = pickProcessErrorMessage({
      ...base,
      stderr: 'auth failed: token expired\n',
      streamErrorMessage: 'codex error: upstream 500',
    });
    expect(msg).toBe('auth failed: token expired');
  });

  it('falls back to streamErrorMessage when stderr is empty', () => {
    const msg = pickProcessErrorMessage({
      ...base,
      stderr: '',
      streamErrorMessage: "The 'gpt-5-codex' model is not supported...",
    });
    expect(msg).toBe("The 'gpt-5-codex' model is not supported...");
  });

  it('falls back to streamErrorMessage when stderr is ONLY noise', () => {
    // This is the exact failure mode from the "Codex not working" bug.
    const msg = pickProcessErrorMessage({
      ...base,
      stderr: 'Reading additional input from stdin...\n',
      streamErrorMessage: 'codex error: HTTP 400 model not supported',
    });
    expect(msg).toBe('codex error: HTTP 400 model not supported');
  });

  it('falls back to a generic message when both stderr and stream are empty', () => {
    const msg = pickProcessErrorMessage({
      ...base,
      stderr: '',
      streamErrorMessage: '',
    });
    expect(msg).toBe('codex-cli exited with code 1');
  });

  it('propagates the engine name into the generic fallback', () => {
    const msg = pickProcessErrorMessage({
      engine: 'claude-code',
      exitCode: 2,
      stderr: '',
      streamErrorMessage: '',
    });
    expect(msg).toBe('claude-code exited with code 2');
  });
});
