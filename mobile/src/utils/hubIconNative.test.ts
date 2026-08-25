// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { HUB_ICON_NAMES } from './hubIconNames';
import { HUB_NATIVE_ICONS, resolveLucideIconName, resolveNativeIcon } from './hubIconNative';
describe('resolveLucideIconName', () => {
  it('maps BarChart3 to ChartColumn for lucide-react-native v1', () => {
    expect(resolveLucideIconName('BarChart3')).toBe('ChartColumn');
    expect(resolveLucideIconName('Settings')).toBe('Settings');
  });
});
describe('HUB_NATIVE_ICONS', () => {
  it('covers every registered Hub icon name', () => {
    for (const name of HUB_ICON_NAMES) {
      expect(resolveNativeIcon(name), `missing native mapping for ${name}`).not.toBeNull();
    }
  });
  it('uses known feather / material glyph names', () => {
    expect(HUB_NATIVE_ICONS.Bot).toEqual({ family: 'material', name: 'robot' });
    expect(HUB_NATIVE_ICONS.ListOrdered).toEqual({
      family: 'material',
      name: 'format-list-numbered',
    });
    expect(HUB_NATIVE_ICONS.Activity).toEqual({ family: 'feather', name: 'activity' });
  });
});
