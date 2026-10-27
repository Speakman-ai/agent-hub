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

  it('reads, updates, and starts the importance scan', async () => {
    await api.getGmailImportance();
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/google/gmail/importance');

    await api.updateGmailImportanceSettings({ enabled: true, windowDays: 30, autoScan: 'daily' });
    const [putUrl, putInit] = fetchSpy.mock.calls[1];
    expect(String(putUrl)).toContain('/api/google/gmail/importance/settings');
    expect(putInit.method).toBe('PUT');
    expect(JSON.parse(putInit.body)).toEqual({ enabled: true, windowDays: 30, autoScan: 'daily' });

    await api.startGmailImportanceScan({ windowDays: 1 });
    const [postUrl, postInit] = fetchSpy.mock.calls[2];
    expect(String(postUrl)).toContain('/api/google/gmail/importance/scan');
    expect(postInit.method).toBe('POST');
    expect(JSON.parse(postInit.body)).toEqual({ windowDays: 1 });
  });

  it('exposes the server error code and status on a failed request', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'scope', code: 'google_chat_send_scope_required' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(api.sendGoogleChatMessage('AAA', { text: 'hi' })).rejects.toMatchObject({
      status: 403,
      code: 'google_chat_send_scope_required',
    });
  });

  it('targets a linked Google account on every Gmail and Calendar call when one is named', async () => {
    await api.listGoogleGmailThreads({ maxResults: 5, account: 'acc home' });
    await api.getGoogleGmailThread('t1', { format: 'full', account: 'acc-home' });
    await api.sendGoogleGmailMessage({ to: ['a@x.com'], text: 'hi' }, { account: 'acc-home' });
    await api.listGoogleCalendarEvents({ timeMin: 'a', timeMax: 'b', account: 'acc-home' });
    await api.createGoogleCalendarEvent({ event: {} }, { account: 'acc-home' });
    await api.updateGoogleCalendarEvent('e1', { event: {} }, { account: 'acc-home' });
    const urls = fetchSpy.mock.calls.map(([url]: any[]) => String(url));
    expect(urls[0]).toContain('account=acc+home');
    for (const url of urls.slice(1)) expect(url).toContain('account=acc-home');

    // Omitted means the default account: no parameter at all.
    await api.sendGoogleGmailMessage({ to: ['a@x.com'], text: 'hi' });
    expect(String(fetchSpy.mock.calls.at(-1)[0])).not.toContain('account=');
  });
});
