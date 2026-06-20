import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SIDEBAR_COLLAPSED_KEY,
  readSidebarCollapsed,
  writeSidebarCollapsed,
} from './sidebarCollapse.js';

describe('sidebarCollapse persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to expanded (false) when nothing is stored', () => {
    expect(readSidebarCollapsed()).toBe(false);
  });

  it('round-trips a collapsed=true write through localStorage', () => {
    writeSidebarCollapsed(true);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1');
    expect(readSidebarCollapsed()).toBe(true);
  });

  it('removes the key (not stores "0") when expanding', () => {
    writeSidebarCollapsed(true);
    writeSidebarCollapsed(false);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull();
    expect(readSidebarCollapsed()).toBe(false);
  });

  it('treats any non-sentinel value as expanded', () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true');
    expect(readSidebarCollapsed()).toBe(false);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '0');
    expect(readSidebarCollapsed()).toBe(false);
  });

  it('returns false when localStorage.getItem throws (storage disabled)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(readSidebarCollapsed()).toBe(false);
    spy.mockRestore();
  });

  it('swallows write errors (quota / private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => writeSidebarCollapsed(true)).not.toThrow();
    spy.mockRestore();
  });
});
