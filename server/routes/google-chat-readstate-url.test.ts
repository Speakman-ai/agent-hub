import { describe, it, expect } from 'vitest';
import { google } from 'googleapis';

// Runs the real googleapis client (no module mock) with a fake fetch, so the
// request URL the read-state route depends on is checked against the
// installed library, not against our own assumptions.
describe('Chat read-state request shape (real googleapis client)', () => {
  const fakeFetch = (calls: string[]) => async (url: unknown, init?: { method?: string }) => {
    calls.push(`${init?.method} ${String(url)}`);
    return new Response('{"lastReadTime":"2026-10-08T11:00:00Z"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  it('updateSpaceReadState binds the resource path from `name`', async () => {
    const calls: string[] = [];
    const chat = google.chat({ version: 'v1' });
    await chat.users.spaces.updateSpaceReadState(
      {
        name: 'users/me/spaces/AAA/spaceReadState',
        updateMask: 'lastReadTime',
        requestBody: { lastReadTime: '2026-10-08T11:00:00Z' },
      },
      { fetchImplementation: fakeFetch(calls) } as Record<string, unknown>,
    );
    expect(calls).toEqual([
      'PATCH https://chat.googleapis.com/v1/users/me/spaces/AAA/spaceReadState?updateMask=lastReadTime',
    ]);
  });

  it('rejects `spaceReadState.name` in place of `name`', async () => {
    const chat = google.chat({ version: 'v1' });
    await expect(
      chat.users.spaces.updateSpaceReadState(
        { 'spaceReadState.name': 'users/me/spaces/AAA/spaceReadState' } as Record<string, unknown>,
        { fetchImplementation: fakeFetch([]) } as Record<string, unknown>,
      ),
    ).rejects.toThrow(/name/);
  });

  it('getSpaceReadState uses the same path', async () => {
    const calls: string[] = [];
    const chat = google.chat({ version: 'v1' });
    await chat.users.spaces.getSpaceReadState({ name: 'users/me/spaces/AAA/spaceReadState' }, {
      fetchImplementation: fakeFetch(calls),
    } as Record<string, unknown>);
    expect(calls).toEqual([
      'GET https://chat.googleapis.com/v1/users/me/spaces/AAA/spaceReadState',
    ]);
  });
});
