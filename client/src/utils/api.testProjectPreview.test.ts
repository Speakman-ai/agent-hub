import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

describe('api.testProjectPreview', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('attaches a defensive AbortSignal so a hung server surfaces in the UI', async () => {
    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ports: { allocated: 3000 }, durationMs: 1234 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await api.testProjectPreview('proj-1');

    const [, opts] = (fetchSpy as any).mock.calls[0];
    expect(opts.method).toBe('POST');
    // The previous behavior passed `timeout: null` which produced no signal.
    // The defensive ceiling MUST produce an AbortSignal so a frozen server
    // does not leave the Test button spinning forever.
    expect(opts.signal).toBeDefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(opts.body)).toEqual({});
  });
});
