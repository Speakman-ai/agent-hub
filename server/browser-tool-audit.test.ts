import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logBrowserToolAudit } from './browser-tool-audit.js';

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
});
