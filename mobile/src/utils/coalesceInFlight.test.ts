// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { coalescePromiseByKey } from './coalesceInFlight';
describe('coalescePromiseByKey', () => {
    it('runs start once for concurrent callers with the same key', async () => {
        const mapRef = { current: new Map() };
        const start = vi.fn().mockImplementation(() => new Promise((r: any) => setTimeout(() => r({ id: 's1' }), 10)));
        const a = coalescePromiseByKey(mapRef, 'agent-a', start);
        const b = coalescePromiseByKey(mapRef, 'agent-a', start);
        const [ra, rb] = await Promise.all([a, b]);
        expect(start).toHaveBeenCalledTimes(1);
        expect(ra).toEqual({ id: 's1' });
        expect(rb).toEqual({ id: 's1' });
    });
    it('uses separate in-flight work per key', async () => {
        const mapRef = { current: new Map() };
        const start = vi.fn().mockImplementation((id: any) => Promise.resolve({ id }));
        const a = coalescePromiseByKey(mapRef, 'k1', () => start('a'));
        const b = coalescePromiseByKey(mapRef, 'k2', () => start('b'));
        await expect(Promise.all([a, b])).resolves.toEqual([{ id: 'a' }, { id: 'b' }]);
        expect(start).toHaveBeenCalledTimes(2);
    });
});
