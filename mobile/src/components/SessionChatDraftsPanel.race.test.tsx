import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  View: 'View',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator',
}));

const apiMock = vi.hoisted(() => ({
  listGoogleChatDrafts: vi.fn(),
  editGoogleChatDraft: vi.fn(),
  approveGoogleChatDraft: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));
const appState = vi.hoisted(() => ({ lastGoogleChatDraftEvent: null as any, connected: true }));
vi.mock('../context/AppContext', () => ({ useApp: () => appState }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: SessionChatDraftsPanel } = await import('./SessionChatDraftsPanel');
process.env.NODE_ENV = originalNodeEnv;

const T = (sec: number) => `2026-10-08T10:00:${String(sec).padStart(2, '0')}.000Z`;
function draft(over: Record<string, unknown>) {
  return {
    id: 'd',
    sessionId: 's-1',
    spaceId: 'AAA',
    threadName: null,
    text: 'hi',
    revision: 1,
    status: 'pending',
    error: null,
    sentMessageName: null,
    createdAt: T(0),
    updatedAt: T(0),
    ...over,
  };
}
function deferred<V>() {
  let resolve!: (v: V) => void;
  const promise = new Promise<V>((r) => (resolve = r));
  return { promise, resolve };
}
const shownIds = (r: any) =>
  r.root
    .findAll(
      (n: any) => typeof n.props?.testID === 'string' && n.props.testID.startsWith('chat-draft-'),
    )
    .map((n: any) => n.props.testID.slice('chat-draft-'.length));

describe('SessionChatDraftsPanel loading (mobile)', () => {
  beforeEach(() => {
    apiMock.listGoogleChatDrafts.mockReset();
    apiMock.editGoogleChatDraft.mockReset();
    apiMock.approveGoogleChatDraft.mockReset();
    appState.lastGoogleChatDraftEvent = null;
    appState.connected = true;
  });

  it('ignores a slow response for the session the user left', async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    apiMock.listGoogleChatDrafts
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    let r: any;
    await act(async () => {
      r = TestRenderer.create(<SessionChatDraftsPanel sessionId="s-1" />);
    });
    await act(async () => r.update(<SessionChatDraftsPanel sessionId="s-2" />));
    await act(async () =>
      second.resolve({ drafts: [draft({ id: 'b', sessionId: 's-2' })], asOf: T(1) }),
    );
    await act(async () => first.resolve({ drafts: [draft({ id: 'a' })], asOf: T(1) }));
    expect(shownIds(r)).toEqual(['b']);
  });

  it('keeps a live update that lands while the list is loading', async () => {
    const load = deferred<any>();
    apiMock.listGoogleChatDrafts.mockReturnValueOnce(load.promise);
    let r: any;
    await act(async () => {
      r = TestRenderer.create(<SessionChatDraftsPanel sessionId="s-1" />);
    });
    appState.lastGoogleChatDraftEvent = {
      draft: draft({ id: 'x', status: 'discarded', updatedAt: T(3) }),
      bump: 1,
    };
    await act(async () => r.update(<SessionChatDraftsPanel sessionId="s-1" />));
    await act(async () =>
      load.resolve({ drafts: [draft({ id: 'x', updatedAt: T(1) })], asOf: T(2) }),
    );
    expect(shownIds(r)).toEqual([]);
  });

  const press = (r: any, label: string) =>
    r.root
      .findAll((n: any) => n.type === 'TouchableOpacity')
      .find((n: any) =>
        n.findAll((c: any) => c.type === 'Text').some((t: any) => t.props.children === label),
      )
      .props.onPress();

  async function startEditThenSwitch() {
    let resolveEdit!: (v: unknown) => void;
    let failEdit!: (e: unknown) => void;
    const editPromise = new Promise((res, rej) => {
      resolveEdit = res;
      failEdit = rej;
    });
    apiMock.listGoogleChatDrafts
      .mockResolvedValueOnce({ drafts: [draft({ id: 'a' })], asOf: T(1) })
      .mockResolvedValueOnce({ drafts: [draft({ id: 'b', sessionId: 's-2' })], asOf: T(2) });
    apiMock.editGoogleChatDraft.mockReturnValueOnce(editPromise);
    let r: any;
    await act(async () => {
      r = TestRenderer.create(<SessionChatDraftsPanel sessionId="s-1" />);
    });
    await act(async () => {
      press(r, 'Edit');
    });
    await act(async () => r.root.findByType('TextInput').props.onChangeText('A edit'));
    // Leave the edit request pending; the card's await must not block act.
    await act(async () => {
      press(r, 'Save draft');
    });
    await act(async () => r.update(<SessionChatDraftsPanel sessionId="s-2" />));
    expect(shownIds(r)).toEqual(['b']);
    return { r, resolve: resolveEdit, reject: failEdit };
  }

  it('drops an edit result from the previous session instead of adding it here', async () => {
    const { r, resolve } = await startEditThenSwitch();
    await act(async () => resolve({ draft: draft({ id: 'a', text: 'A edit', updatedAt: T(3) }) }));
    expect(shownIds(r)).toEqual(['b']);
  });

  it('a failed action from the previous session does not reload over this one', async () => {
    const { r, reject } = await startEditThenSwitch();
    expect(apiMock.listGoogleChatDrafts).toHaveBeenCalledTimes(2);
    await act(async () => reject(new Error('boom')));
    expect(apiMock.listGoogleChatDrafts).toHaveBeenCalledTimes(2);
    expect(shownIds(r)).toEqual(['b']);
  });

  afterEach(() => vi.useRealTimers());

  it('keeps the last good list when a refresh fails, then recovers on retry', async () => {
    vi.useFakeTimers();
    apiMock.listGoogleChatDrafts
      .mockResolvedValueOnce({ drafts: [draft({ id: 'a', status: 'sending' })], asOf: T(1) })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        drafts: [draft({ id: 'a', status: 'unconfirmed', updatedAt: T(9) })],
        asOf: T(10),
      });
    let r: any;
    await act(async () => {
      r = TestRenderer.create(<SessionChatDraftsPanel sessionId="s-1" />);
    });
    expect(shownIds(r)).toEqual(['a']);
    // The sending re-read fails: the draft stays on screen with a retry.
    const retry = () =>
      r.root
        .findAll((n: any) => n.type === 'TouchableOpacity')
        .find((n: any) =>
          n
            .findAll((c: any) => c.type === 'Text')
            .some((t: any) => t.props.children === 'Retry now'),
        );
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(shownIds(r)).toEqual(['a']);
    expect(retry()).toBeTruthy();
    await act(async () => {
      retry().props.onPress();
    });
    expect(retry()).toBeUndefined();
    expect(apiMock.listGoogleChatDrafts).toHaveBeenCalledTimes(3);
  });

  it('re-reads on socket reconnect, picking up a draft created during the outage', async () => {
    apiMock.listGoogleChatDrafts
      .mockResolvedValueOnce({ drafts: [], asOf: T(1) })
      .mockResolvedValueOnce({ drafts: [draft({ id: 'missed', updatedAt: T(5) })], asOf: T(6) });
    let r: any;
    await act(async () => {
      r = TestRenderer.create(<SessionChatDraftsPanel sessionId="s-1" />);
    });
    expect(shownIds(r)).toEqual([]);
    appState.connected = false;
    await act(async () => r.update(<SessionChatDraftsPanel sessionId="s-1" />));
    expect(apiMock.listGoogleChatDrafts).toHaveBeenCalledTimes(1);
    appState.connected = true;
    await act(async () => r.update(<SessionChatDraftsPanel sessionId="s-1" />));
    expect(apiMock.listGoogleChatDrafts).toHaveBeenCalledTimes(2);
    expect(shownIds(r)).toEqual(['missed']);
  });

  const texts = (r: any) =>
    r.root
      .findAll((n: any) => n.type === 'Text')
      .map((t: any) => [].concat(t.props.children).join(''));
  const button = (r: any, label: string) =>
    r.root
      .findAll((n: any) => n.type === 'TouchableOpacity')
      .find((n: any) =>
        n.findAll((c: any) => c.type === 'Text').some((t: any) => t.props.children === label),
      );

  it('recovers from an edit conflict without leaving the session', async () => {
    apiMock.listGoogleChatDrafts.mockResolvedValue({ drafts: [draft({ id: 'a' })], asOf: T(1) });
    apiMock.approveGoogleChatDraft.mockResolvedValue({
      draft: draft({ id: 'a', status: 'sent', updatedAt: T(9) }),
    });
    let r: any;
    await act(async () => {
      r = TestRenderer.create(<SessionChatDraftsPanel sessionId="s-1" />);
    });
    await act(async () => {
      button(r, 'Edit').props.onPress();
    });
    expect(button(r, 'Cancel')).toBeTruthy();

    // Another device saves an edit while this one is editing.
    appState.lastGoogleChatDraftEvent = {
      draft: draft({ id: 'a', text: 'Other device', revision: 2, updatedAt: T(5) }),
      bump: 1,
    };
    await act(async () => r.update(<SessionChatDraftsPanel sessionId="s-1" />));
    expect(r.root.findAll((n: any) => n.props?.testID === 'chat-draft-stale')).toHaveLength(1);
    expect(texts(r)).toContain('Other device');
    // Stale-revision actions are disabled until the user decides.
    expect(button(r, 'Save draft').props.disabled).toBe(true);
    expect(button(r, 'Discard').props.disabled).toBe(true);

    await act(async () => {
      button(r, 'Use current version').props.onPress();
    });
    expect(r.root.findAll((n: any) => n.props?.testID === 'chat-draft-stale')).toHaveLength(0);
    await act(async () => {
      button(r, 'Approve and send').props.onPress();
    });
    expect(apiMock.approveGoogleChatDraft).toHaveBeenCalledWith('a', 2, undefined);
  });

  it('can keep its own edit on top of the newer version', async () => {
    apiMock.listGoogleChatDrafts.mockResolvedValue({ drafts: [draft({ id: 'a' })], asOf: T(1) });
    apiMock.editGoogleChatDraft.mockResolvedValue({
      draft: draft({ id: 'a', text: 'Mine', revision: 3, updatedAt: T(9) }),
    });
    let r: any;
    await act(async () => {
      r = TestRenderer.create(<SessionChatDraftsPanel sessionId="s-1" />);
    });
    await act(async () => {
      button(r, 'Edit').props.onPress();
    });
    await act(async () => r.root.findByType('TextInput').props.onChangeText('Mine'));
    appState.lastGoogleChatDraftEvent = {
      draft: draft({ id: 'a', text: 'Other device', revision: 2, updatedAt: T(5) }),
      bump: 2,
    };
    await act(async () => r.update(<SessionChatDraftsPanel sessionId="s-1" />));
    await act(async () => {
      button(r, 'Keep my edit').props.onPress();
    });
    await act(async () => {
      button(r, 'Save draft').props.onPress();
    });
    expect(apiMock.editGoogleChatDraft).toHaveBeenCalledWith('a', 2, 'Mine');
  });
});
