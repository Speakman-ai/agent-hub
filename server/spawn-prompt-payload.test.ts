import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  MAX_ARG_STRLEN_BYTES,
  SAFE_ARG_STRLEN_BYTES,
  writeSystemPromptFile,
  applyArgvPromptCap,
  logArgvCapTruncation,
  buildHistoryBootstrapPrompt,
} from './spawn-prompt-payload.js';

describe('spawn-prompt-payload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constants', () => {
    it('exposes the kernel cap as 128 KiB (PAGE_SIZE * 32)', () => {
      // This number is hard-coded into the Linux kernel's fs/exec.c
      // for x86_64 / arm64 hosts with 4 KiB pages. If a target with a
      // different page size ever shows up, this test will catch it
      // and we'll need a per-arch derivation.
      expect(MAX_ARG_STRLEN_BYTES).toBe(131072);
    });

    it('keeps the soft cap below the kernel cap with headroom', () => {
      // ~28 KiB of headroom for engine flags, config paths,
      // session ids, and any growth in the prompt builder.
      expect(SAFE_ARG_STRLEN_BYTES).toBeLessThan(MAX_ARG_STRLEN_BYTES);
      expect(MAX_ARG_STRLEN_BYTES - SAFE_ARG_STRLEN_BYTES).toBeGreaterThanOrEqual(20_000);
    });
  });

  describe('writeSystemPromptFile', () => {
    it('writes the prompt to a tmp file and returns a cleanup that removes it', () => {
      const sessionId = 'a1b2c3d4-e5f6-7890-aaaa-bbbbccccdddd';
      const content = '# System Prompt\n\nHello world.\nLine 3.';
      const { path: filePath, cleanup } = writeSystemPromptFile(content, sessionId);

      try {
        expect(filePath).toMatch(new RegExp(`^${os.tmpdir().replace(/\\/g, '\\\\')}`));
        expect(path.basename(filePath)).toBe('system-prompt.md');
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, 'utf8')).toBe(content);
      } finally {
        cleanup();
      }

      // Cleanup removes the entire per-spawn dir, not just the file.
      expect(existsSync(filePath)).toBe(false);
      expect(existsSync(path.dirname(filePath))).toBe(false);
    });

    it('handles prompts larger than the kernel argv cap (the actual bug)', () => {
      // 200 KiB — beyond MAX_ARG_STRLEN. Writing to disk has no such
      // limit, which is the whole point of this helper.
      const huge = 'x'.repeat(200_000);
      const { path: filePath, cleanup } = writeSystemPromptFile(huge, 'session-id');
      try {
        const written = readFileSync(filePath, 'utf8');
        expect(written.length).toBe(huge.length);
        expect(Buffer.byteLength(written, 'utf8')).toBeGreaterThan(MAX_ARG_STRLEN_BYTES);
      } finally {
        cleanup();
      }
    });

    it('cleanup is best-effort — safe to call twice', () => {
      const { cleanup } = writeSystemPromptFile('payload', 'sid');
      cleanup();
      // Second call must not throw — we rely on this from both the
      // 'error' and 'close' handlers in chat.ts.
      expect(() => cleanup()).not.toThrow();
    });
  });

  describe('applyArgvPromptCap', () => {
    it('returns the prompt unchanged when below the cap', () => {
      const prompt = 'short prompt';
      const result = applyArgvPromptCap(prompt);
      expect(result.truncated).toBe(false);
      expect(result.prompt).toBe(prompt);
      expect(result.originalBytes).toBe(Buffer.byteLength(prompt, 'utf8'));
    });

    it('trims when over the cap and prefixes a truncation marker', () => {
      const enriched = 'A'.repeat(150_000); // > kernel cap
      const result = applyArgvPromptCap(enriched);
      expect(result.truncated).toBe(true);
      expect(result.originalBytes).toBe(150_000);
      expect(Buffer.byteLength(result.prompt, 'utf8')).toBeLessThanOrEqual(SAFE_ARG_STRLEN_BYTES);
      // Marker is human-readable so the agent (and reviewer) sees what happened.
      expect(result.prompt.startsWith('[NOTE: enriched system prompt truncated')).toBe(true);
    });

    it('keeps the tail (current-turn message) when trimming the head', () => {
      // Construct a prompt that's mostly noise with a distinctive tail.
      // The tail is what the user actually typed this turn — it must
      // survive truncation or the agent can't respond to the request.
      const noise = 'N'.repeat(SAFE_ARG_STRLEN_BYTES);
      const tail = '\n\nUSER_QUESTION_MARKER what is 2+2?';
      const result = applyArgvPromptCap(noise + tail);
      expect(result.truncated).toBe(true);
      expect(result.prompt).toContain('USER_QUESTION_MARKER what is 2+2?');
    });

    it('respects a caller-supplied cap', () => {
      const result = applyArgvPromptCap('x'.repeat(2000), 1000);
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.prompt, 'utf8')).toBeLessThanOrEqual(1000);
    });
  });

  describe('logArgvCapTruncation', () => {
    it('emits a v2 TOOL_ERROR line with the expected tags', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      logArgvCapTruncation('cursor-agent', 'session-abc', 200_000, 100_000);
      expect(errSpy).toHaveBeenCalledTimes(1);
      const logged = errSpy.mock.calls[0][0] as string;
      // Structural assertions: anchor to the field shape so a future
      // change to the daily-note format flags itself in this test
      // before it lands in production.
      expect(logged).toMatch(/^TOOL_ERROR \| /);
      expect(logged).toContain(' | spawn-prompt | argv-cap-trim | warn |');
      expect(logged).toContain('200000B > argv cap 100000B');
      // JSON tail
      expect(logged).toContain('"v":2');
      expect(logged).toContain('"sev":"soft"');
      expect(logged).toContain('"resolution":"recovered"');
      expect(logged).toContain('"session":"session-abc"');
      expect(logged).toContain('"argv-cap"');
      expect(logged).toContain('"cursor-agent"');
    });
  });
});

describe('buildHistoryBootstrapPrompt', () => {
  const forwardedTranscript = (bytes: number) =>
    [
      'Please pick up where we left off and finish the migration.',
      '',
      '--- Forwarded from session with Survey Tracker Dev ---',
      '[User]:\n' + 'x'.repeat(bytes),
      '--- End of forwarded context ---',
    ].join('\n');

  it('inlines the full history when it fits under the cap', () => {
    const res = buildHistoryBootstrapPrompt(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      'continue',
    );
    expect(res.truncated).toBe(false);
    expect(res.omittedMessages).toBe(0);
    expect(res.prompt).toBe(
      'Previous conversation:\nHuman: hello\n\nAssistant: hi there\n\nHuman: continue',
    );
  });

  it('returns the current turn untouched when there is no history', () => {
    const res = buildHistoryBootstrapPrompt([], 'just this');
    expect(res.prompt).toBe('just this');
    expect(res.truncated).toBe(false);
  });

  // Regression: an oversized forwarded transcript used to be dropped
  // wholesale, so the target agent received only the user's new message and
  // looked like it had ignored the forward. Both ends of the transcript must
  // survive — the head carries the forwarder's instructions and provenance.
  it('keeps head and tail of an oversized forwarded transcript instead of dropping it', () => {
    const content = forwardedTranscript(400_000);
    const res = buildHistoryBootstrapPrompt(
      [{ role: 'user', content }],
      'What is the first thing I should do?',
    );

    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.prompt, 'utf8')).toBeLessThanOrEqual(SAFE_ARG_STRLEN_BYTES);
    expect(res.prompt).toContain('Please pick up where we left off');
    expect(res.prompt).toContain('--- Forwarded from session with Survey Tracker Dev ---');
    expect(res.prompt).toContain('--- End of forwarded context ---');
    expect(res.prompt).toContain('omitted from the middle of this message');
    expect(res.prompt).toContain('Human: What is the first thing I should do?');
    expect(res.originalBytes).toBeGreaterThan(400_000);
  });

  it('never drops the current turn', () => {
    const res = buildHistoryBootstrapPrompt(
      [{ role: 'user', content: 'y'.repeat(500_000) }],
      'the actual question',
    );
    expect(res.prompt).toContain('the actual question');
    expect(Buffer.byteLength(res.prompt, 'utf8')).toBeLessThanOrEqual(SAFE_ARG_STRLEN_BYTES);
  });

  it('fills history newest-first and reports how many older messages it dropped', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i} ` + 'z'.repeat(10_000),
    }));
    const res = buildHistoryBootstrapPrompt(messages, 'now what');

    expect(res.truncated).toBe(true);
    expect(res.omittedMessages).toBeGreaterThan(0);
    expect(Buffer.byteLength(res.prompt, 'utf8')).toBeLessThanOrEqual(SAFE_ARG_STRLEN_BYTES);
    expect(res.prompt).toContain('msg-39');
    expect(res.prompt).not.toContain('msg-0 ');
    expect(res.prompt).toContain(`${res.omittedMessages} earlier messages omitted`);
  });

  it('sends the current turn alone when it alone exceeds the cap', () => {
    const huge = 'q'.repeat(SAFE_ARG_STRLEN_BYTES + 10);
    const res = buildHistoryBootstrapPrompt([{ role: 'user', content: 'context' }], huge);
    expect(res.prompt).toBe(huge);
    expect(res.truncated).toBe(true);
    expect(res.omittedMessages).toBe(1);
  });

  it('respects an explicit cap', () => {
    const res = buildHistoryBootstrapPrompt(
      [{ role: 'user', content: 'a'.repeat(50_000) }],
      'go',
      20_000,
    );
    expect(Buffer.byteLength(res.prompt, 'utf8')).toBeLessThanOrEqual(20_000);
    expect(res.truncated).toBe(true);
  });

  // When no history slice fits, the framing is still worth keeping: it is what
  // tells the agent that history existed and was dropped.
  it('keeps the omission notice when only the framing fits under a small cap', () => {
    const res = buildHistoryBootstrapPrompt(
      [{ role: 'user', content: 'a'.repeat(50_000) }],
      'go',
      300,
    );

    expect(Buffer.byteLength(res.prompt, 'utf8')).toBeLessThanOrEqual(300);
    expect(res.prompt).toContain('Previous conversation:');
    expect(res.prompt).toContain('1 earlier message omitted');
    expect(res.prompt).toContain('Human: go');
    expect(res.omittedMessages).toBe(1);
  });

  it('drops the framing rather than exceed a cap too small to hold it', () => {
    const res = buildHistoryBootstrapPrompt(
      [{ role: 'user', content: 'a'.repeat(50_000) }],
      'go',
      100,
    );

    expect(res.prompt).toBe('go');
    expect(Buffer.byteLength(res.prompt, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('stays within every cap that can hold the current turn', () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i} ` + 'z'.repeat(9_000),
    }));
    for (const cap of [120, 300, 1_000, 2_500, 5_000, 20_000, 100_000]) {
      const res = buildHistoryBootstrapPrompt(messages, 'now what', cap);
      expect(Buffer.byteLength(res.prompt, 'utf8')).toBeLessThanOrEqual(cap);
      expect(res.prompt).toContain('now what');
    }
  });
});
