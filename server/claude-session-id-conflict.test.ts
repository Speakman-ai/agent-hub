/**
 * Tests for the Claude Code "Session ID … is already in use" detector.
 * Regression coverage for the wedged-session bug:
 *   - chat.ts spawns Claude with `--session-id <X>` for new sessions
 *   - Claude creates `~/.claude/projects/<cwd>/<X>.jsonl` on disk
 *   - If the spawn dies before any `assistant_text` arrives, our DB never
 *     records `engine_session_id`, but the JSONL is on disk
 *   - The next turn re-spawns with `--session-id <same X>` and Claude
 *     responds: "Error: Session ID X is already in use."
 *
 * The detector lets the close handler self-heal by persisting the id and
 * rewriting the user-facing error to invite a retry (which uses `--resume`).
 */
import { describe, it, expect } from 'vitest';
import {
  detectSessionIdInUseError,
  buildSessionIdInUseRecoveryMessage,
  detectNoConversationFoundError,
  buildNoConversationFoundRecoveryMessage,
} from './claude-session-id-conflict.js';

describe('detectSessionIdInUseError', () => {
  it('extracts the session id from the canonical CLI error line', () => {
    const stderr = 'Error: Session ID d1de0ab1-dda9-4165-9b0d-26b657d8e2b7 is already in use.';
    expect(detectSessionIdInUseError(stderr)).toEqual({
      sessionId: 'd1de0ab1-dda9-4165-9b0d-26b657d8e2b7',
    });
  });

  it('matches when the error appears in a multi-line stderr buffer', () => {
    const stderr = [
      'some preamble line',
      'Error: Session ID 9aaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee is already in use.',
      'Stack trace follows...',
    ].join('\n');
    expect(detectSessionIdInUseError(stderr)).toEqual({
      sessionId: '9aaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
  });

  it('matches without the `Error:` prefix (resilient to upstream wording tweaks)', () => {
    const stderr = 'Session ID 11111111-2222-3333-4444-555555555555 is already in use';
    expect(detectSessionIdInUseError(stderr)).toEqual({
      sessionId: '11111111-2222-3333-4444-555555555555',
    });
  });

  it('returns null for unrelated stderr', () => {
    expect(detectSessionIdInUseError('claude-code: command not found')).toBeNull();
    expect(detectSessionIdInUseError('Reading additional input from stdin...')).toBeNull();
    expect(detectSessionIdInUseError('')).toBeNull();
  });

  it('returns null when "already in use" is mentioned without a uuid', () => {
    // We deliberately key off the uuid pattern so we don't false-match unrelated
    // "already in use" mentions (e.g. "port 3051 is already in use").
    expect(detectSessionIdInUseError('port 3051 is already in use')).toBeNull();
    expect(detectSessionIdInUseError('Error: Session ID is already in use.')).toBeNull();
  });

  it('does not match a non-uuid token', () => {
    // Guard against shape drift — only canonical uuids are recovered. A bad
    // shape means our recovery write would target a bogus row, so we
    // intentionally bail out.
    expect(detectSessionIdInUseError('Session ID abc is already in use.')).toBeNull();
  });
});

describe('buildSessionIdInUseRecoveryMessage', () => {
  it('embeds the session id and tells the user to retry', () => {
    const msg = buildSessionIdInUseRecoveryMessage('d1de0ab1-dda9-4165-9b0d-26b657d8e2b7');
    expect(msg).toContain('d1de0ab1-dda9-4165-9b0d-26b657d8e2b7');
    expect(msg.toLowerCase()).toContain('please send your message again');
  });
});

describe('detectNoConversationFoundError', () => {
  it('extracts the session id from the canonical CLI stderr line', () => {
    const stderr = 'No conversation found with session ID: 1971381b-c994-4530-a13f-f7644c49ce7d';
    expect(detectNoConversationFoundError(stderr)).toEqual({
      sessionId: '1971381b-c994-4530-a13f-f7644c49ce7d',
    });
  });

  it('returns null for unrelated stderr', () => {
    expect(detectNoConversationFoundError('Session ID foo is already in use')).toBeNull();
  });
});

describe('buildNoConversationFoundRecoveryMessage', () => {
  it('tells the user the engine link was cleared', () => {
    const msg = buildNoConversationFoundRecoveryMessage('1971381b-c994-4530-a13f-f7644c49ce7d');
    expect(msg).toContain('1971381b-c994-4530-a13f-f7644c49ce7d');
    expect(msg.toLowerCase()).toContain('cleared the engine link');
  });
});
