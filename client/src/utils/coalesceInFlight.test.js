import { describe, it, expect, vi } from 'vitest';
import { coalescePromiseByKey } from './coalesceInFlight.js';

describe('coalescePromiseByKey', () => {
  it('runs start once for concurrent callers with the same key', async () => {
    const mapRef = { current: new Map() };
    const start = vi
      .fn()
      .mockImplementation(() => new Promise((r) => setTimeout(() => r({ id: 's1' }), 10)));
    const a = coalescePromiseByKey(mapRef, 'agent-a', start);
    const b = coalescePromiseByKey(mapRef, 'agent-a', start);
    const [ra, rb] = await Promise.all([a, b]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(ra).toEqual({ id: 's1' });
    expect(rb).toEqual({ id: 's1' });
  });

  it('uses separate in-flight work per key', async () => {
    const mapRef = { current: new Map() };
    const start = vi.fn().mockImplementation((id) => Promise.resolve({ id }));
    const a = coalescePromiseByKey(mapRef, 'k1', () => start('a'));
    const b = coalescePromiseByKey(mapRef, 'k2', () => start('b'));
    await expect(Promise.all([a, b])).resolves.toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('clears the slot after settle so a later call can start again', async () => {
    const mapRef = { current: new Map() };
    const start = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await expect(coalescePromiseByKey(mapRef, 'x', () => start())).resolves.toBe(1);
    await expect(coalescePromiseByKey(mapRef, 'x', () => start())).resolves.toBe(2);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('clears the slot on rejection', async () => {
    const mapRef = { current: new Map() };
    const err = new Error('boom');
    const start = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('ok');
    await expect(coalescePromiseByKey(mapRef, 'x', () => start())).rejects.toThrow('boom');
    await expect(coalescePromiseByKey(mapRef, 'x', () => start())).resolves.toBe('ok');
    expect(start).toHaveBeenCalledTimes(2);
  });
});
