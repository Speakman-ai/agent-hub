import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clearChatParticipantCache,
  participantNames,
  resolveChatParticipants,
} from './google-chat-participants.js';

const member = (name: string, displayName: string | null, type = 'HUMAN') => ({
  member: { name, displayName, type },
});

describe('google-chat-participants', () => {
  beforeEach(() => clearChatParticipantCache());

  it('names other humans, without the caller, bots, blanks, or duplicates', () => {
    expect(
      participantNames(
        [
          member('users/me', 'Ryan'),
          member('users/1', 'Dana'),
          member('users/2', 'Jira', 'BOT'),
          member('users/3', ''),
          member('users/4', 'Dana'),
        ],
        'users/me',
      ),
    ).toEqual(['Dana']);
  });

  it('caches per user and space, and only resolves up to the budget per call', async () => {
    const listMembers = vi.fn(async (space: string) => ({
      members: [member('users/x', `Name ${space}`)],
      complete: true,
    }));
    const spaceNames = ['spaces/A', 'spaces/B', 'spaces/C'];

    const first = await resolveChatParticipants({
      userId: 'u1',
      selfUserName: null,
      spaceNames,
      listMembers,
      budget: 2,
      now: 1000,
    });
    expect([...first.keys()]).toEqual(['spaces/A', 'spaces/B']);
    expect(listMembers).toHaveBeenCalledTimes(2);

    // Next load: A and B from cache, C fills in.
    const second = await resolveChatParticipants({
      userId: 'u1',
      selfUserName: null,
      spaceNames,
      listMembers,
      budget: 2,
      now: 2000,
    });
    expect(second.get('spaces/C')).toEqual(['Name spaces/C']);
    expect(listMembers).toHaveBeenCalledTimes(3);

    // Another Hub user never sees u1's cache.
    await resolveChatParticipants({
      userId: 'u2',
      selfUserName: null,
      spaceNames: ['spaces/A'],
      listMembers,
      now: 2000,
    });
    expect(listMembers).toHaveBeenCalledTimes(4);
  });

  it('leaves a space unresolved when its lookup fails', async () => {
    const out = await resolveChatParticipants({
      userId: 'u1',
      selfUserName: null,
      spaceNames: ['spaces/A', 'spaces/B'],
      listMembers: async (space) => {
        if (space === 'spaces/A') throw new Error('403');
        return { members: [member('users/1', 'Lee')], complete: true };
      },
    });
    expect(out.has('spaces/A')).toBe(false);
    expect(out.get('spaces/B')).toEqual(['Lee']);
  });

  it('returns but never caches a partial member list', async () => {
    const listMembers = vi.fn(async () => ({
      members: [member('users/1', 'Dana')],
      complete: false,
    }));
    const opts = { userId: 'u1', selfUserName: null, spaceNames: ['spaces/BIG'], listMembers };
    expect((await resolveChatParticipants(opts)).get('spaces/BIG')).toEqual(['Dana']);
    await resolveChatParticipants(opts);
    expect(listMembers).toHaveBeenCalledTimes(2);
  });
});
