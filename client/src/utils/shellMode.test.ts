import { beforeEach, describe, expect, it } from 'vitest';
import {
  hubSidebarSessions,
  isSimpleViewChat,
  SHELL_MODE_KEY,
  buildSimpleContacts,
  isSimpleChatAgent,
  filterSimpleContacts,
  moveSimpleContact,
  orderSimpleContacts,
  pickNewestSession,
  readShellMode,
  readSimpleRosterOrder,
  reconcileSimpleRosterOrder,
  SIMPLE_ROSTER_ORDER_KEY,
  simpleShellMustLeaveFor,
  rememberPreSimpleTarget,
  takePreSimpleTarget,
  writeShellMode,
  writeSimpleRosterOrder,
} from './shellMode';

describe('shellMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to the full Hub and only treats an explicit simple value as the simple view', () => {
    expect(readShellMode()).toBe('hub');
    localStorage.setItem(SHELL_MODE_KEY, 'nope');
    expect(readShellMode()).toBe('hub');
    writeShellMode('simple');
    expect(readShellMode()).toBe('simple');
    expect(localStorage.getItem(SHELL_MODE_KEY)).toBe('simple');
  });

  it('picks the newest session by updated_at', () => {
    const newest = pickNewestSession([
      { id: 'old', name: 'Old', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'new', name: 'New', updated_at: '2026-02-01T00:00:00Z' },
      { id: 'mid', name: 'Mid', created_at: '2026-01-15T00:00:00Z' },
    ]);
    expect(newest?.id).toBe('new');
    expect(pickNewestSession([])).toBeNull();
  });

  it('hides helper agents and leaves roster order alone when a chat needs you', () => {
    const contacts = buildSimpleContacts({
      agents: [
        { id: 'busy', name: 'Bea', projectName: 'Docs', role: 'dev', active: true },
        { id: 'lead', name: 'Ada', projectName: 'Hub', role: 'lead', active: true },
        { id: 'rev', name: 'Reviewer', projectName: 'Hub', role: 'reviewer', active: true },
        { id: 'docs', name: 'Docs', projectName: 'Hub', role: 'docs', active: true },
        { id: 'qa', name: 'QA', projectName: 'Hub', role: 'qa', active: true },
        { id: 'off', name: 'Retired', projectName: 'Hub', active: false },
      ],
      sessionsByAgentId: {
        lead: [
          {
            id: 's-ask',
            name: 'Ship the button',
            session_mode: 'consult',
            updated_at: '2026-03-01T00:00:00Z',
          },
          {
            id: 's-build',
            name: 'Building',
            session_mode: 'chat',
            updated_at: '2026-06-01T00:00:00Z',
          },
        ],
        busy: [
          {
            id: 's-work',
            name: 'Writing docs',
            session_mode: 'consult',
            updated_at: '2026-04-01T00:00:00Z',
          },
        ],
        rev: [
          {
            id: 's-rev',
            name: 'Review',
            session_mode: 'consult',
            updated_at: '2026-05-01T00:00:00Z',
          },
        ],
      },
      activeTaskSessionIds: { 's-work': true, 's-build': true },
      needsInputBySession: { 's-ask': { kind: 'question', at: 1 } },
    });

    expect(contacts.map((contact) => contact.agentId)).toEqual(['busy', 'lead']);
    expect(isSimpleChatAgent({ role: 'docs' })).toBe(false);
    expect(isSimpleChatAgent({ role: 'dev' })).toBe(true);
    expect(contacts.find((contact) => contact.agentId === 'lead')).toMatchObject({
      status: 'needs-you',
      preview: 'Needs you',
      sessionId: 's-ask',
    });
    expect(contacts.find((contact) => contact.agentId === 'busy')).toMatchObject({
      status: 'working',
      preview: 'Working…',
      sessionId: 's-work',
    });
  });

  it('previews the remembered session instead of a newer cron row', () => {
    const contacts = buildSimpleContacts({
      agents: [{ id: 'lead', name: 'Ada', projectName: 'Hub', active: true }],
      sessionsByAgentId: {
        lead: [
          {
            id: 'cron',
            name: 'Nightly digest',
            session_mode: 'consult',
            cron_id: 4,
            updated_at: '2026-06-02T00:00:00Z',
          },
          {
            id: 'chat',
            name: 'The button',
            session_mode: 'consult',
            updated_at: '2026-06-01T00:00:00Z',
          },
          {
            id: 'build',
            name: 'Newer build',
            session_mode: 'chat',
            updated_at: '2026-07-01T00:00:00Z',
          },
        ],
      },
      rememberedSessionIds: { lead: 'chat' },
    });
    expect(contacts[0]).toMatchObject({ sessionId: 'chat', preview: 'Hub · The button' });
  });

  it('uses the loaded agent session list instead of a stale cache', () => {
    const contacts = buildSimpleContacts({
      agents: [{ id: 'lead', name: 'Ada', projectName: 'Hub', active: true }],
      loadedSessionsAgentId: 'lead',
      activeSessions: [
        {
          id: 'live',
          name: 'Live thread',
          session_mode: 'consult',
          updated_at: '2026-06-01T00:00:00Z',
        },
      ],
      sessionsByAgentId: {
        lead: [
          {
            id: 'stale',
            name: 'Stale',
            session_mode: 'consult',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });
    expect(contacts[0]).toMatchObject({
      sessionId: 'live',
      preview: 'Hub · Live thread',
      status: 'idle',
    });
  });

  it('shows Needs you only for the red exclamation state', () => {
    const cleared = buildSimpleContacts({
      agents: [{ id: 'lead', name: 'Ada', projectName: 'Hub', active: true }],
      sessionsByAgentId: {
        lead: [
          {
            id: 's-ask',
            name: 'Chat',
            session_mode: 'consult',
            updated_at: '2026-03-01T00:00:00Z',
          },
        ],
      },
      needsInputBySession: { 's-ask': { kind: null, at: 5 } },
    });
    expect(cleared[0]?.status).toBe('idle');

    const disputed = buildSimpleContacts({
      agents: [{ id: 'lead', name: 'Ada', projectName: 'Hub', active: true }],
      sessionsByAgentId: {
        lead: [
          { id: 'chat', name: 'Chat', session_mode: 'consult', updated_at: '2026-03-01T00:00:00Z' },
          { id: 'build', name: 'Fix it', session_mode: 'chat', updated_at: '2026-04-01T00:00:00Z' },
        ],
      },
      finalizeStatusBySession: { build: 'disputed' },
    });
    expect(disputed[0]).toMatchObject({
      status: 'needs-you',
      preview: 'Needs you',
      sessionId: 'chat',
    });
  });

  it('remembers one return target for the shell and hands it back once', () => {
    rememberPreSimpleTarget('ada', 'build-1', 'chat');
    rememberPreSimpleTarget('cam', 'build-2', null);
    expect(takePreSimpleTarget()).toEqual({ agentId: 'cam', sessionId: 'build-2' });
    expect(takePreSimpleTarget()).toBeNull();
  });

  it('clears the target when the simple view is entered from a consult or Hub thread', () => {
    rememberPreSimpleTarget('ada', 'build-1', 'chat');
    rememberPreSimpleTarget('ada', 'consult-1', 'consult');
    expect(takePreSimpleTarget()).toBeNull();
    rememberPreSimpleTarget('ada', 'build-1', 'chat');
    rememberPreSimpleTarget(null, 'hub-1', 'hub');
    expect(takePreSimpleTarget()).toBeNull();
  });

  it('filters contacts by every word in the query', () => {
    const contacts = buildSimpleContacts({
      agents: [
        { id: 'a', name: 'Ada', projectName: 'Hub', active: true },
        { id: 'b', name: 'Bea', projectName: 'Docs', active: true },
      ],
      sessionsByAgentId: {
        a: [
          {
            id: 's1',
            name: 'Fix the roster',
            session_mode: 'consult',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        b: [
          {
            id: 's2',
            name: 'Calendar notes',
            session_mode: 'consult',
            updated_at: '2026-01-02T00:00:00Z',
          },
        ],
      },
    });
    expect(filterSimpleContacts(contacts, 'hub roster').map((contact) => contact.agentId)).toEqual([
      'a',
    ]);
    expect(filterSimpleContacts(contacts, '   ').map((contact) => contact.agentId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('keeps a saved sidebar order and appends agents that are new', () => {
    expect(reconcileSimpleRosterOrder(['cam', 'ada'], ['ada', 'bea', 'cam'])).toEqual([
      'cam',
      'ada',
      'bea',
    ]);
    expect(reconcileSimpleRosterOrder(['cam'], [])).toEqual(['cam']);
    expect(reconcileSimpleRosterOrder([], ['ada', 'bea'])).toEqual(['ada', 'bea']);
    expect(moveSimpleContact(['ada', 'bea', 'cam'], 'ada', 'cam')).toEqual(['bea', 'cam', 'ada']);
    expect(moveSimpleContact(['ada', 'bea', 'cam'], 'cam', 'ada')).toEqual(['cam', 'ada', 'bea']);
    expect(moveSimpleContact(['ada', 'bea'], 'ada', 'ada')).toBeNull();

    const contacts = buildSimpleContacts({
      agents: [
        { id: 'ada', name: 'Ada', active: true },
        { id: 'bea', name: 'Bea', active: true },
      ],
    });
    expect(orderSimpleContacts(contacts, ['bea', 'ada']).map((contact) => contact.agentId)).toEqual(
      ['bea', 'ada'],
    );

    writeSimpleRosterOrder(['bea', 'ada']);
    expect(readSimpleRosterOrder()).toEqual(['bea', 'ada']);
    localStorage.setItem(SIMPLE_ROSTER_ORDER_KEY, 'not-json');
    expect(readSimpleRosterOrder()).toEqual([]);
  });
});

describe('simpleShellMustLeaveFor', () => {
  it('leaves for a known non-consult session', () => {
    expect(simpleShellMustLeaveFor({ session_mode: null })).toBe(true);
    expect(simpleShellMustLeaveFor({ session_mode: 'design' })).toBe(true);
    expect(simpleShellMustLeaveFor({ session_mode: 'consult', sidebar_parent_id: 'p' })).toBe(true);
    expect(simpleShellMustLeaveFor({ session_mode: 'consult', cron_id: 'c' })).toBe(true);
  });

  it('stays for a consult chat or a row that has not loaded', () => {
    expect(simpleShellMustLeaveFor({ session_mode: 'consult' })).toBe(false);
    expect(simpleShellMustLeaveFor(undefined)).toBe(false);
    expect(simpleShellMustLeaveFor(null)).toBe(false);
  });
});

describe('hubSidebarSessions', () => {
  it('leaves Simple view chats out of the Hub sidebar', () => {
    const rows = [
      { id: 'a', session_mode: 'consult', simple_chat: 1 },
      { id: 'b', session_mode: 'consult', simple_chat: 0 },
      { id: 'c', session_mode: 'chat' },
    ];
    expect(hubSidebarSessions(rows).map((row) => row.id)).toEqual(['b', 'c']);
    expect(isSimpleViewChat(rows[0])).toBe(true);
    expect(isSimpleViewChat(rows[1])).toBe(false);
    expect(isSimpleViewChat(null)).toBe(false);
  });

  it('returns the same array when nothing is filtered', () => {
    const rows = [{ id: 'a' }, { id: 'b', simple_chat: 0 }];
    expect(hubSidebarSessions(rows)).toBe(rows);
  });
});
