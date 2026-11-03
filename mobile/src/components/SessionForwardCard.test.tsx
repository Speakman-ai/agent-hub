import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedForward } from '@shared/utils/extractForwardBlocks';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));

const storage = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    store,
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

const dispatchSession = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ api: { dispatchSession } }));
vi.mock('../utils/auth', () => ({ getAuthRecord: () => ({ user: { id: 'user-1' } }) }));
vi.mock('../utils/config', () => ({ getServerBaseUrl: () => 'https://hub.test' }));

// The production React build has no `act`; load the development one.
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { default: SessionForwardCard, forwardStore } = await import('./SessionForwardCard');
process.env.NODE_ENV = originalNodeEnv;
const act = TestRenderer.act;

const forward: ExtractedForward = {
  forwardId: 'fwd-mobile',
  projectId: 'app',
  agentId: 'ada',
  name: 'Fix login',
  summary: 'Repair the redirect.',
  prompt: 'Fix the login redirect.',
  mode: 'manual',
};

function byId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findByProps({ testID });
}

describe('SessionForwardCard (mobile)', () => {
  beforeEach(() => {
    dispatchSession.mockReset();
    storage.store.clear();
    forwardStore.clear();
  });

  it('starts the session at the chosen ship level', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-9',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '@[Fix login](session:sess-9)',
    });
    const onOpenSession = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SessionForwardCard
          forward={forward}
          agents={[{ id: 'ada', name: 'Ada' }]}
          onOpenSession={onOpenSession}
        />,
      );
    });
    expect(byId(renderer, 'session-forward-summary').props.children).toBe('Repair the redirect.');
    await act(async () => {
      byId(renderer, 'session-forward-mode').props.onPress();
    });
    await act(async () => {
      byId(renderer, 'session-forward-mode-merge').props.onPress();
    });
    await act(async () => {
      await byId(renderer, 'session-forward').props.onPress();
    });
    expect(dispatchSession).toHaveBeenCalledWith('app', {
      prompt: forward.prompt,
      agentId: 'ada',
      name: 'Fix login',
      mode: 'merge',
    });
    await act(async () => {
      byId(renderer, 'session-forward-open').props.onPress();
    });
    expect(onOpenSession).toHaveBeenCalledWith('ada', 'sess-9');
    renderer.unmount();
  });

  async function mount(props: Record<string, unknown>) {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SessionForwardCard forward={forward} onOpenSession={() => {}} {...props} />,
      );
    });
    return renderer;
  }

  function has(renderer: ReactTestRenderer, testID: string): boolean {
    return renderer.root.findAllByProps({ testID }).length > 0;
  }

  it('keeps identical requests in different messages separate and restores each on reload', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    const first = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    await act(async () => {
      await byId(first, 'session-forward').props.onPress();
    });
    expect(has(first, 'session-forward-open')).toBe(true);
    first.unmount();

    const other = await mount({ sessionId: 'chat-1', messageId: 'm-2' });
    expect(has(other, 'session-forward')).toBe(true);
    expect(has(other, 'session-forward-open')).toBe(false);
    other.unmount();

    const reloaded = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    expect(has(reloaded, 'session-forward-open')).toBe(true);
    expect(has(reloaded, 'session-forward')).toBe(false);
    reloaded.unmount();
    expect(dispatchSession).toHaveBeenCalledTimes(1);
  });

  it('offers Consult only and dispatches it for a workflow project', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-wf',
      agentId: 'ops',
      projectId: 'ops',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    const renderer = await mount({
      forward: { ...forward, projectId: 'ops', agentId: 'ops', mode: 'push' },
      projects: [{ id: 'ops', mode: 'workflow' }],
      sessionId: 'hub-1',
      messageId: 'm-1',
    });
    await act(async () => {
      byId(renderer, 'session-forward-mode').props.onPress();
    });
    expect(has(renderer, 'session-forward-mode-consult')).toBe(true);
    expect(has(renderer, 'session-forward-mode-merge')).toBe(false);
    await act(async () => {
      byId(renderer, 'session-forward-mode-consult').props.onPress();
    });
    await act(async () => {
      await byId(renderer, 'session-forward').props.onPress();
    });
    expect(dispatchSession).toHaveBeenCalledWith('ops', {
      prompt: forward.prompt,
      agentId: 'ops',
      name: 'Fix login',
      mode: 'consult',
    });
    renderer.unmount();
  });

  it('does not dispatch while the saved record for a forwarded card is still loading', async () => {
    let release!: (value: string | null) => void;
    storage.getItem.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
    );
    const renderer = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    const button = byId(renderer, 'session-forward');
    expect(button.props.disabled).toBe(true);
    await act(async () => {
      await button.props.onPress();
    });
    expect(dispatchSession).not.toHaveBeenCalled();

    await act(async () => {
      release(
        JSON.stringify({ sessionId: 'sess-old', agentId: 'ada', name: 'Fix login', mode: 'push' }),
      );
    });
    expect(has(renderer, 'session-forward-open')).toBe(true);
    expect(has(renderer, 'session-forward')).toBe(false);
    expect(dispatchSession).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('resets its claim when the same component is reused for another card', async () => {
    dispatchSession
      .mockResolvedValueOnce({
        sessionId: 'sess-a',
        agentId: 'ada',
        projectId: 'app',
        name: 'A',
        skippedSkills: [],
        ref: '',
      })
      .mockResolvedValueOnce({
        sessionId: 'sess-b',
        agentId: 'ada',
        projectId: 'app',
        name: 'B',
        skippedSkills: [],
        ref: '',
      });
    const next = { ...forward, forwardId: 'fwd-next', prompt: 'Add logout.' };
    const renderer = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    await act(async () => {
      await byId(renderer, 'session-forward').props.onPress();
    });
    expect(has(renderer, 'session-forward-open')).toBe(true);

    await act(async () => {
      renderer.update(
        <SessionForwardCard
          forward={next}
          sessionId="chat-1"
          messageId="m-2"
          onOpenSession={() => {}}
        />,
      );
    });
    expect(byId(renderer, 'session-forward').props.disabled).toBe(false);
    await act(async () => {
      await byId(renderer, 'session-forward').props.onPress();
    });
    expect(has(renderer, 'session-forward-open')).toBe(true);
    expect(dispatchSession).toHaveBeenCalledTimes(2);
    expect(dispatchSession).toHaveBeenLastCalledWith(
      'app',
      expect.objectContaining({ prompt: 'Add logout.' }),
    );
    renderer.unmount();
  });

  it('does not show an in-flight dispatch result on the card that replaced it', async () => {
    let finish!: (value: unknown) => void;
    dispatchSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const next = { ...forward, forwardId: 'fwd-next', prompt: 'Add logout.' };
    const renderer = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    let pressed!: Promise<void>;
    await act(async () => {
      pressed = byId(renderer, 'session-forward').props.onPress();
    });
    await act(async () => {
      renderer.update(
        <SessionForwardCard
          forward={next}
          sessionId="chat-1"
          messageId="m-2"
          onOpenSession={() => {}}
        />,
      );
    });
    await act(async () => {
      finish({
        sessionId: 'sess-a',
        agentId: 'ada',
        projectId: 'app',
        name: 'A',
        skippedSkills: [],
        ref: '',
      });
      await pressed;
    });
    expect(has(renderer, 'session-forward-open')).toBe(false);
    expect(byId(renderer, 'session-forward').props.disabled).toBe(false);
    expect(storage.store.size).toBe(1);
    renderer.unmount();
  });

  it('starts one session when the card unmounts and remounts mid-dispatch', async () => {
    let finish!: (value: unknown) => void;
    dispatchSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    let pressed!: Promise<void>;
    await act(async () => {
      pressed = byId(first, 'session-forward').props.onPress();
    });
    first.unmount();

    const second = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    expect(byId(second, 'session-forward').props.disabled).toBe(true);
    await act(async () => {
      await byId(second, 'session-forward').props.onPress();
    });
    expect(dispatchSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({
        sessionId: 'sess-1',
        agentId: 'ada',
        projectId: 'app',
        name: 'Fix login',
        skippedSkills: [],
        ref: '',
      });
      await pressed;
    });
    expect(has(second, 'session-forward-open')).toBe(true);
    expect(has(second, 'session-forward')).toBe(false);
    expect(dispatchSession).toHaveBeenCalledTimes(1);
    second.unmount();
  });
});
