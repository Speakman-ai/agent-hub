import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

describe('api release notification helpers', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('retries a release notification with the scoped deployment endpoint', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ notification: { id: 'note/1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await api.retryReleaseNotification('agent-hub', 'dep-1', 'note/1');

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain(
      '/api/projects/agent-hub/deployments/dep-1/release-notifications/note%2F1/retry',
    );
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({});
  });
});
