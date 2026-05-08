import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  logBrowserToolAudit,
  redactUrlForBrowserAudit,
  sanitizeBrowserToolAuditDetail,
} from './browser-tool-audit.js';

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

describe('sanitizeBrowserToolAuditDetail', () => {
  it('redacts successful navigate detail from navigateUrl even when hostDetail was truncated raw URL', () => {
    expect(
      sanitizeBrowserToolAuditDetail({
        op: 'navigate',
        hostExit: 0,
        hostDetail:
          'https://evil.test/callback?token=THIS_SHOULDNOT_APPEAR_AND_IS_LONG_' + 'x'.repeat(90),
        navigateUrl: 'https://evil.test/callback?token=sekret&id=999',
      }),
    ).toBe('https://evil.test/callback');
  });

  it('redacts back/forward success hostDetail URLs', () => {
    expect(
      sanitizeBrowserToolAuditDetail({
        op: 'back',
        hostExit: 0,
        hostDetail: 'https://a.test/r?sig=opaque',
      }),
    ).toBe('https://a.test/r');
  });

  it('redacts embedded https URL query strings from Playwright-style error lines', () => {
    expect(
      sanitizeBrowserToolAuditDetail({
        op: 'navigate',
        hostExit: 1,
        hostDetail:
          'Timeout 30000ms exceeded: navigation to https://app.test/oauth?token=sekret&id=99 failed.',
      }),
    ).toBe('Timeout 30000ms exceeded: navigation to https://app.test/oauth failed.');
  });

  it('leaves error text without urls unchanged aside from truncation', () => {
    expect(
      sanitizeBrowserToolAuditDetail({
        op: 'navigate',
        hostExit: 1,
        hostDetail: 'Only http',
      }),
    ).toBe('Only http');
  });

  it('redacts urls inside ASCII double quotes before the closing delimiter', () => {
    expect(
      sanitizeBrowserToolAuditDetail({
        op: 'click',
        hostExit: 1,
        hostDetail: 'Error opening "https://x.example/here?secret=1"',
      }),
    ).toBe('Error opening "https://x.example/here"');
  });

  describe('with mocked console.log', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    it('emitted audit JSON has no ? or # in detail for navigational success', () => {
      logBrowserToolAudit({
        chatSessionId: 'audit',
        op: 'forward',
        ok: true,
        hostExit: 0,
        detail: sanitizeBrowserToolAuditDetail({
          op: 'forward',
          hostExit: 0,
          hostDetail: 'https://z.example/dashboard?jwt=evil#x',
        }),
      });
      const line = logSpy.mock.calls[0][0].replace(/^\[browser-tool-audit\]\s*/, '');
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.detail).toBe('https://z.example/dashboard');
      expect(String(parsed.detail)).not.toMatch(/[?#]/);
    });
  });
});
