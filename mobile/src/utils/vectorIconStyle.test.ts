// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
// The mobile vitest runs in a Node environment with no React Native transform,
// so a real `react-native` import (Flow-typed `index.js`) fails to parse. This
// util only needs `Platform.OS`; stub it so the pure layout logic stays
// testable without pulling in the native module graph.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
const { iconTextStyle } = await import('./vectorIconStyle.js');
describe('iconTextStyle', () => {
    it('sets width, height, and lineHeight to the icon size', () => {
        const style = iconTextStyle(14);
        expect(style[0]).toMatchObject({
            width: 14,
            height: 14,
            lineHeight: 14,
            textAlign: 'center',
        });
    });
    it('merges extra styles after the base layout', () => {
        const style = iconTextStyle(12, { color: '#fff' });
        expect(style[1]).toEqual({ color: '#fff' });
    });
});
