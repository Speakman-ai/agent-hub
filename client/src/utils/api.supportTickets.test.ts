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

describe('api.linkSupportTicketToCard', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ linked: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('POSTs the trimmed cardId + comment to the link-card endpoint', async () => {
    await api.linkSupportTicketToCard('project-1', 'ticket-1', {
      cardId: '  card-9  ',
      comment: '  already fixed  ',
    });

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/projects\/project-1\/support-tickets\/ticket-1\/link-card$/);
    expect(options?.method).toBe('POST');
    expect(JSON.parse(options?.body as string)).toEqual({
      cardId: 'card-9',
      comment: 'already fixed',
    });
  });

  it('omits a blank comment', async () => {
    await api.linkSupportTicketToCard('project-1', 'ticket-1', {
      cardId: 'card-9',
      comment: '   ',
    });

    const [, options] = fetchSpy.mock.calls[0];
    expect(JSON.parse(options?.body as string)).toEqual({ cardId: 'card-9' });
  });
});
