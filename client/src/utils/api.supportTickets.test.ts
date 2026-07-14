import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

describe('api.runSupportTicketInvestigation', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ queued: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends an empty JSON object when no investigation selection is provided', async () => {
    await api.runSupportTicketInvestigation('project-1', 'ticket-1');

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/projects\/project-1\/support-tickets\/ticket-1\/investigate$/);
    expect(options?.method).toBe('POST');
    expect(options?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(options?.body).toBe('{}');
  });
});
