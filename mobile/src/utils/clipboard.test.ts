// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { sanitizeCopyPayload, canCopy, copyToClipboard, pasteFromClipboard } from './clipboard';
function makeProvider(overrides: any = {}) {
  return {
    setStringAsync: vi.fn(async () => true),
    getStringAsync: vi.fn(async () => ''),
    hasStringAsync: vi.fn(async () => true),
    ...overrides,
  };
}
describe('sanitizeCopyPayload', () => {
  it('returns empty string for nullish input', () => {
    expect(sanitizeCopyPayload(null)).toBe('');
    expect(sanitizeCopyPayload(undefined)).toBe('');
  });
  it('trims surrounding whitespace', () => {
    expect(sanitizeCopyPayload('  hello  ')).toBe('hello');
  });
  it('strips a single trailing newline before trimming', () => {
    expect(sanitizeCopyPayload('hello\n')).toBe('hello');
  });
  it('coerces non-string values to strings', () => {
    expect(sanitizeCopyPayload(42)).toBe('42');
  });
  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeCopyPayload('   \n  ')).toBe('');
  });
});
describe('canCopy', () => {
  it('returns true for meaningful content', () => {
    expect(canCopy('hello')).toBe(true);
  });
  it('returns false for empty / whitespace / nullish content', () => {
    expect(canCopy('')).toBe(false);
    expect(canCopy('   ')).toBe(false);
    expect(canCopy(null)).toBe(false);
    expect(canCopy(undefined)).toBe(false);
  });
});
describe('copyToClipboard', () => {
  it('writes sanitized payload via provider and returns true', async () => {
    const provider = makeProvider();
    const ok = await copyToClipboard('  hi there\n', { provider });
    expect(ok).toBe(true);
    expect(provider.setStringAsync).toHaveBeenCalledTimes(1);
    expect(provider.setStringAsync).toHaveBeenCalledWith('hi there');
  });
  it('returns false without calling provider when payload is empty', async () => {
    const provider = makeProvider();
    const ok = await copyToClipboard('   \n', { provider });
    expect(ok).toBe(false);
    expect(provider.setStringAsync).not.toHaveBeenCalled();
  });
  it('returns false when the provider throws', async () => {
    const provider = makeProvider({
      setStringAsync: vi.fn(async () => {
        throw new Error('clipboard unavailable');
      }),
    });
    const ok = await copyToClipboard('hello', { provider });
    expect(ok).toBe(false);
  });
  it('treats nullish input as empty', async () => {
    const provider = makeProvider();
    expect(await copyToClipboard(null, { provider })).toBe(false);
    expect(await copyToClipboard(undefined, { provider })).toBe(false);
    expect(provider.setStringAsync).not.toHaveBeenCalled();
  });
});
describe('pasteFromClipboard', () => {
  it('returns clipboard contents when hasString is true', async () => {
    const provider = makeProvider({
      hasStringAsync: vi.fn(async () => true),
      getStringAsync: vi.fn(async () => 'pasted text'),
    });
    const text = await pasteFromClipboard({ provider });
    expect(text).toBe('pasted text');
    expect(provider.hasStringAsync).toHaveBeenCalled();
    expect(provider.getStringAsync).toHaveBeenCalled();
  });
  it('returns empty string without fetching when hasString is false', async () => {
    const provider = makeProvider({
      hasStringAsync: vi.fn(async () => false),
      getStringAsync: vi.fn(async () => 'should not see this'),
    });
    const text = await pasteFromClipboard({ provider });
    expect(text).toBe('');
    expect(provider.getStringAsync).not.toHaveBeenCalled();
  });
  it('falls back to getStringAsync when provider has no hasStringAsync', async () => {
    const provider = {
      setStringAsync: vi.fn(),
      getStringAsync: vi.fn(async () => 'direct'),
      hasStringAsync: null,
    };
    const text = await pasteFromClipboard({ provider });
    expect(text).toBe('direct');
  });
  it('returns empty string when provider throws', async () => {
    const provider = makeProvider({
      hasStringAsync: vi.fn(async () => true),
      getStringAsync: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    });
    const text = await pasteFromClipboard({ provider });
    expect(text).toBe('');
  });
  it('returns empty string when provider yields a non-string', async () => {
    const provider = makeProvider({
      hasStringAsync: vi.fn(async () => true),
      getStringAsync: vi.fn(async () => null),
    });
    const text = await pasteFromClipboard({ provider });
    expect(text).toBe('');
  });
});
