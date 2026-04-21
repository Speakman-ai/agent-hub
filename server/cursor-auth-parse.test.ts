import { describe, it, expect } from 'vitest';
import {
  extractCursorLoginUrl,
  parseCursorStatusJson,
  computeCursorUiStatus,
} from './cursor-auth-parse.js';

describe('extractCursorLoginUrl', () => {
  it('pulls the cursor.com deep-link from NO_OPEN_BROWSER login output', () => {
    const text =
      'Waiting for browser authentication...\nOpen a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=x&uuid=y&mode=login&redirectTarget=cli\n';
    expect(extractCursorLoginUrl(text)).toBe(
      'https://cursor.com/loginDeepControl?challenge=x&uuid=y&mode=login&redirectTarget=cli',
    );
  });

  it('strips ANSI before matching', () => {
    const text = '\x1b[90mhttps://cursor.com/loginDeepControl?a=1\x1b[0m';
    expect(extractCursorLoginUrl(text)).toBe('https://cursor.com/loginDeepControl?a=1');
  });

  it('returns null when no URL', () => {
    expect(extractCursorLoginUrl('nothing here')).toBeNull();
  });
});

describe('parseCursorStatusJson', () => {
  it('parses authenticated payload', () => {
    const j = JSON.stringify({
      status: 'authenticated',
      isAuthenticated: true,
      userInfo: { email: 'a@b.com' },
    });
    expect(parseCursorStatusJson(j, '')).toEqual({
      ok: true,
      isAuthenticated: true,
      email: 'a@b.com',
    });
  });

  it('parses unauthenticated payload', () => {
    const j = JSON.stringify({
      status: 'unauthenticated',
      isAuthenticated: false,
      message: 'Not logged in',
    });
    expect(parseCursorStatusJson(j, '')).toMatchObject({
      ok: true,
      isAuthenticated: false,
    });
  });

  it('returns error on invalid JSON', () => {
    const r = parseCursorStatusJson('not-json', '');
    expect(r.ok).toBe(false);
    expect(r.isAuthenticated).toBe(false);
    expect(r.error).toContain('not-json');
  });

  it('parses JSON after leading warnings / noise on stderr', () => {
    const noisy =
      'Warning: some deprecation text\n' +
      JSON.stringify({
        isAuthenticated: true,
        userInfo: { email: 'x@y.com' },
      }) +
      '\n';
    expect(parseCursorStatusJson('', noisy)).toEqual({
      ok: true,
      isAuthenticated: true,
      email: 'x@y.com',
    });
  });
});

describe('computeCursorUiStatus', () => {
  it('returns missing when binary absent', () => {
    expect(
      computeCursorUiStatus({
        binaryPresent: false,
        loginInProgress: false,
        isAuthenticated: false,
      }),
    ).toBe('missing');
  });

  it('returns pending when login in progress', () => {
    expect(
      computeCursorUiStatus({
        binaryPresent: true,
        loginInProgress: true,
        isAuthenticated: false,
      }),
    ).toBe('pending');
  });

  it('returns authenticated when logged in', () => {
    expect(
      computeCursorUiStatus({
        binaryPresent: true,
        loginInProgress: false,
        isAuthenticated: true,
      }),
    ).toBe('authenticated');
  });
});
