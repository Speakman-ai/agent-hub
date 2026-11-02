import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
      setItem: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    },
  };
});

import {
  buildSimpleContacts,
  filterSimpleContacts,
  isSimpleChatAgent,
  moveSimpleContact,
  reconcileSimpleRosterOrder,
  sessionShowsNeedsYou,
  simpleContactStatus,
  rememberPreSimpleTarget,
  takePreSimpleTarget,
  writeShellMode,
  readShellMode,
} from './simpleShell';

const agent = (id: string, role = 'dev') => ({ id, name: id, role, projectName: 'Hub' });

describe('simple shell roster', () => {
  it('hides reviewer, docs, QA, skill builder, and the hub assistant', () => {
    for (const role of ['reviewer', 'docs', 'qa', 'skill-builder', 'hub-assistant']) {
      expect(isSimpleChatAgent({ role })).toBe(false);
    }
    expect(isSimpleChatAgent({ role: 'dev' })).toBe(true);
  });

  it('keeps the saved order when a later agent needs you', () => {
    const contacts = buildSimpleContacts({
      agents: [agent('ada'), agent('cam'), agent('reviewer', 'reviewer')],
      sessionsByAgentId: {
        ada: [{ id: 'ada-chat', session_mode: 'consult', name: 'Hello', updated_at: '2020-01-01' }],
        cam: [
          {
            id: 'cam-chat',
            session_mode: 'consult',
            name: 'Question',
            finalize_status: 'disputed',
          },
        ],
      },
    });
    expect(contacts.map((contact) => contact.agentId)).toEqual(['ada', 'cam']);
    expect(contacts[1]?.status).toBe('needs-you');
    expect(filterSimpleContacts(contacts, '').map((contact) => contact.agentId)).toEqual([
      'ada',
      'cam',
    ]);
  });

  it('treats a cleared needs-input entry as idle and a disputed review as needs you', () => {
    expect(
      sessionShowsNeedsYou(
        { id: 's1', session_mode: 'consult' },
        { needsInputBySession: { s1: { kind: null, at: 5 } } },
      ),
    ).toBe(false);
    expect(
      sessionShowsNeedsYou({ id: 's2', session_mode: 'build', finalize_status: 'disputed' }, {}),
    ).toBe(true);
  });

  it('counts working only on the consult thread, and needs-you wins', () => {
    const consult = { id: 'chat', session_mode: 'consult' as const };
    const build = { id: 'build', session_mode: 'build' as const };
    expect(simpleContactStatus([build], { activeTaskSessionIds: { build: true } })).toBe('idle');
    expect(simpleContactStatus([consult], { activeTaskSessionIds: { chat: true } })).toBe(
      'working',
    );
    expect(
      simpleContactStatus([consult], {
        activeTaskSessionIds: { chat: true },
        needsInputBySession: { chat: { kind: 'question', at: 1 } },
      }),
    ).toBe('needs-you');
  });

  it('drops a contact into the slot it was released on', () => {
    expect(moveSimpleContact(['ada', 'cam', 'bea'], 'ada', 'bea')).toEqual(['cam', 'bea', 'ada']);
    expect(reconcileSimpleRosterOrder(['cam', 'gone'], ['ada', 'cam'])).toEqual(['cam', 'ada']);
    expect(reconcileSimpleRosterOrder(['cam'], [])).toEqual(['cam']);
  });

  it('remembers the shell and restores a stashed build session once', async () => {
    await writeShellMode('simple');
    expect(await readShellMode()).toBe('simple');
    await rememberPreSimpleTarget('ada', 'build-1', 'build');
    expect(await takePreSimpleTarget()).toEqual({ agentId: 'ada', sessionId: 'build-1' });
    expect(await takePreSimpleTarget()).toBeNull();
  });

  it('clears the return target when Simple is entered from a consult or Hub thread', async () => {
    await rememberPreSimpleTarget('ada', 'build-1', 'build');
    await rememberPreSimpleTarget('ada', 'chat-1', 'consult');
    expect(await takePreSimpleTarget()).toBeNull();
    await rememberPreSimpleTarget('ada', 'build-1', 'build');
    await rememberPreSimpleTarget(null, 'hub-1', 'hub');
    expect(await takePreSimpleTarget()).toBeNull();
  });
});
