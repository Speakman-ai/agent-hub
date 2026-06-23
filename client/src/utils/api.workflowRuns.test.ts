import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

describe('api workflow run endpoints', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('GET run detail hits the scoped runs URL', async () => {
    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ run: { id: 'r1' }, step_runs: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await api.getWorkflowRunDetail('proj-1', 'wf-2', 'run-3');

    const [url] = (fetchSpy as any).mock.calls[0];
    expect(url!).toContain('/api/projects/proj-1/workflows/wf-2/runs/run-3');
  });

  it('POST cancel sends JSON body to cancel URL', async () => {
    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ ok: true, cancelRequested: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await api.cancelWorkflowRun('p', 'w', 'r');

    const [url, opts] = (fetchSpy as any).mock.calls[0];
    expect(url!).toContain('/runs/r/cancel');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({});
  });

  it('POST start run omits body keys when no payload is passed', async () => {
    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ id: 'new-run', status: 'pending' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await api.startWorkflowRun('p', 'w');

    const [, opts] = (fetchSpy as any).mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{}');
  });
});
