import { describe, it, expect } from 'vitest';
import {
  ICON_AVATAR_PREFIX,
  AVATAR_ICON_NAMES,
  isIconAvatar,
  parseIconAvatar,
  buildIconAvatar,
  resolveAvatarImageSrc,
} from './avatar.js';

describe('avatar helpers', () => {
  describe('isIconAvatar', () => {
    it('returns true for "icon:Name" strings', () => {
      expect(isIconAvatar('icon:Rocket')).toBe(true);
    });

    it('returns false for upload paths', () => {
      expect(isIconAvatar('/uploads/abc.png')).toBe(false);
    });

    it('returns false for empty / non-string values', () => {
      expect(isIconAvatar('')).toBe(false);
      expect(isIconAvatar(null)).toBe(false);
      expect(isIconAvatar(undefined)).toBe(false);
      expect(isIconAvatar(42)).toBe(false);
    });
  });

  describe('parseIconAvatar', () => {
    it('returns the icon name for icon avatars', () => {
      expect(parseIconAvatar('icon:Bot')).toBe('Bot');
    });

    it('returns null for non-icon avatars', () => {
      expect(parseIconAvatar('/uploads/x.png')).toBeNull();
      expect(parseIconAvatar('')).toBeNull();
    });

    it('returns null when prefix has no name', () => {
      expect(parseIconAvatar('icon:')).toBeNull();
      expect(parseIconAvatar('icon:   ')).toBeNull();
    });
  });

  describe('buildIconAvatar', () => {
    it('prefixes the icon name', () => {
      expect(buildIconAvatar('Bot')).toBe(`${ICON_AVATAR_PREFIX}Bot`);
    });
  });

  describe('resolveAvatarImageSrc', () => {
    it('returns null for icon avatars (caller renders icon component)', () => {
      expect(resolveAvatarImageSrc('icon:Bot', '/api')).toBeNull();
    });

    it('returns null for empty values', () => {
      expect(resolveAvatarImageSrc('', '/api')).toBeNull();
      expect(resolveAvatarImageSrc(null, '/api')).toBeNull();
    });

    it('prefixes relative paths with serverBase', () => {
      expect(resolveAvatarImageSrc('/uploads/a.png', '/api')).toBe('/api/uploads/a.png');
    });

    it('returns absolute URLs unchanged', () => {
      expect(resolveAvatarImageSrc('https://cdn.example.com/a.png', '/api')).toBe(
        'https://cdn.example.com/a.png',
      );
    });

    it('falls back to the raw path when no serverBase is provided', () => {
      expect(resolveAvatarImageSrc('/uploads/a.png')).toBe('/uploads/a.png');
    });
  });

  describe('AVATAR_ICON_NAMES', () => {
    it('exposes at least 30 icons', () => {
      expect(AVATAR_ICON_NAMES.length).toBeGreaterThanOrEqual(30);
    });

    it('contains only non-empty strings with no duplicates', () => {
      const seen = new Set();
      for (const name of AVATAR_ICON_NAMES) {
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    });
  });
});
