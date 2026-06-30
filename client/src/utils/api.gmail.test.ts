import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

describe('api Gmail helpers', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, threads: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('lists threads through the user-scoped Gmail proxy', async () => {
    await api.listGoogleGmailThreads({ q: 'is:unread', maxResults: 25, includeSpamTrash: false });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/google/gmail/threads?');
    expect(String(url)).toContain('q=is%3Aunread');
    expect(String(url)).toContain('maxResults=25');
    expect(String(url)).toContain('includeSpamTrash=false');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('appends each labelId as a repeated query param', async () => {
    await api.listGoogleGmailThreads({ labelIds: ['INBOX', 'IMPORTANT'] });
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('labelIds=INBOX');
    expect(String(url)).toContain('labelIds=IMPORTANT');
  });

  it('reads a thread with a format param', async () => {
    await api.getGoogleGmailThread('t1/2', { format: 'full' });
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/google/gmail/threads/t1%2F2?format=full');
  });

  it('sends a message via POST through the Gmail proxy', async () => {
    await api.sendGoogleGmailMessage({ to: ['a@x.com'], subject: 'Hi', text: 'Body' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/google/gmail/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ to: ['a@x.com'], subject: 'Hi', text: 'Body' });
  });
});
