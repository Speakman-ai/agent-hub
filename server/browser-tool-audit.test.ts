import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logBrowserToolAudit, redactUrlForBrowserAudit } from './browser-tool-audit.js';

describe('browser-tool-audit', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('emits JSON with core fields prefixed for log aggregation', () => {
    logBrowserToolAudit({
      chatSessionId: 'sess-abc',
      op: 'navigate',
      ok: false,
      hostExit: 1,
      detail: 'Only http',
      urlSnippet: 'https://example.test/path',
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0];
    expect(typeof line).toBe('string');
    expect(line.startsWith('[browser-tool-audit]')).toBe(true);
    const jsonPart = line.replace(/^\[browser-tool-audit\]\s*/, '');
    const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
    expect(parsed.kind).toBe('browser_tool');
    expect(parsed.chatSessionId).toBe('sess-abc');
    expect(parsed.op).toBe('navigate');
    expect(parsed.ok).toBe(false);
    expect(parsed.hostExit).toBe(1);
    expect(parsed.detail).toContain('Only http');
    expect(parsed.urlSnippet).toBe('https://example.test/path');
  });

  it('strips query and hash from navigate urlSnippet in emitted JSON', () => {
    logBrowserToolAudit({
      chatSessionId: 's',
      op: 'navigate',
      ok: true,
      hostExit: 0,
      urlSnippet: redactUrlForBrowserAudit(
        'https://app.example/oauth?access_token=sekret&code=abc#frag',
      ),
    });
    const line = logSpy.mock.calls[0][0].replace(/^\[browser-tool-audit\]\s*/, '');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.urlSnippet).toBe('https://app.example/oauth');
    expect(String(parsed.urlSnippet)).not.toContain('token');
    expect(String(parsed.urlSnippet)).not.toContain('code=');
  });
});

describe('redactUrlForBrowserAudit', () => {
  it('drops search and hash', () => {
    expect(redactUrlForBrowserAudit('https://h.test/p?q=1')).toBe('https://h.test/p');
    expect(redactUrlForBrowserAudit('https://h.test/x#h')).toBe('https://h.test/x');
  });

  it('returns undefined for empty input', () => {
    expect(redactUrlForBrowserAudit(undefined)).toBeUndefined();
    expect(redactUrlForBrowserAudit('  ')).toBeUndefined();
  });
});
