import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('react-native-markdown-display', () => ({ default: 'Markdown' }));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));

const apiMock = vi.hoisted(() => ({
  saveContext: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { default: ContextFilePanel } = await import('./ContextFilePanel');
process.env.NODE_ENV = originalNodeEnv;

function create(props: any): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(ContextFilePanel, props));
  });
  return renderer;
}

describe('mobile ContextFilePanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a loading state and no editor while the read is pending', () => {
    const r = create({
      filename: 'AGENTS.md',
      content: null,
      agentId: 'agent-a',
      defaultExpanded: true,
      loading: true,
    });
    expect(r.root.findAllByProps({ testID: 'context-file-AGENTS.md-loading' }).length).toBe(1);
    expect(r.root.findAllByProps({ testID: 'context-file-AGENTS.md-error' }).length).toBe(0);
    // No editable textarea is offered for un-loaded content.
    expect(r.root.findAllByType('TextInput' as any).length).toBe(0);
  });

  it('gates a rejected read behind an error + retry, never an empty editor', () => {
    const onRetry = vi.fn();
    const r = create({
      filename: 'AGENTS.md',
      content: null,
      agentId: 'agent-a',
      defaultExpanded: true,
      error: true,
      onRetry,
    });
    expect(r.root.findAllByProps({ testID: 'context-file-AGENTS.md-error' }).length).toBe(1);
    expect(r.root.findAllByType('TextInput' as any).length).toBe(0);
    TestRenderer.act(() => {
      r.root.findByProps({ testID: 'context-file-AGENTS.md-retry' }).props.onPress();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(apiMock.saveContext).not.toHaveBeenCalled();
  });

  it('drops the editor when content goes null (e.g. switching projects)', () => {
    const r = create({
      filename: 'AGENTS.md',
      content: 'ALPHA_BODY',
      agentId: 'agent-a',
      defaultExpanded: true,
    });
    // Loaded content renders an Edit affordance.
    expect(r.root.findAllByProps({ children: 'Edit' }).length).toBe(1);
    // Switch to a pending read: content null + loading gates the panel again.
    TestRenderer.act(() => {
      r.update(
        React.createElement(ContextFilePanel, {
          filename: 'AGENTS.md',
          content: null,
          agentId: 'agent-b',
          defaultExpanded: true,
          loading: true,
        }),
      );
    });
    expect(r.root.findAllByProps({ children: 'Edit' }).length).toBe(0);
    expect(r.root.findAllByType('TextInput' as any).length).toBe(0);
    expect(apiMock.saveContext).not.toHaveBeenCalled();
  });

  it('resets the edit buffer on agent switch even when content is identical', () => {
    const r = create({
      filename: 'IDENTITY.md',
      content: 'SAME_BODY',
      agentId: 'agent-a',
      defaultExpanded: true,
    });
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Edit' }).parent!.props.onPress();
    });
    // Agent A has an unsaved edit in the buffer.
    TestRenderer.act(() => {
      r.root.findByType('TextInput' as any).props.onChangeText('A_UNSAVED_EDIT');
    });
    expect(r.root.findByType('TextInput' as any).props.value).toBe('A_UNSAVED_EDIT');

    // Switch to a different agent whose IDENTITY.md is identical, so `content`
    // never changes — only `agentId` does.
    TestRenderer.act(() => {
      r.update(
        React.createElement(ContextFilePanel, {
          filename: 'IDENTITY.md',
          content: 'SAME_BODY',
          agentId: 'agent-b',
          defaultExpanded: true,
        }),
      );
    });
    expect(r.root.findAllByType('TextInput' as any).length).toBe(0);
    expect(r.root.findAllByProps({ children: 'Editing' }).length).toBe(0);

    // Reopen B's editor: it shows B's original content, NOT A's leftover buffer.
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Edit' }).parent!.props.onPress();
    });
    expect(r.root.findByType('TextInput' as any).props.value).toBe('SAME_BODY');
  });

  it('surfaces a conflict error and preserves the buffer when a save is rejected', async () => {
    apiMock.saveContext.mockRejectedValue(new Error('409: stale_write'));
    const onSaved = vi.fn();
    const r = create({
      filename: 'IDENTITY.md',
      content: 'BASE',
      agentId: 'agent-a',
      defaultExpanded: true,
      onSaved,
    });
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Edit' }).parent!.props.onPress();
    });
    TestRenderer.act(() => {
      r.root.findByType('TextInput' as any).props.onChangeText('MY EDIT');
    });
    await TestRenderer.act(async () => {
      r.root.findByProps({ children: 'Save' }).parent!.props.onPress();
    });

    const err = r.root.findByProps({ testID: 'context-file-IDENTITY.md-save-error' });
    expect(String(err.props.children)).toMatch(/changed since you opened it/i);
    // Buffer preserved, editor still open, nothing applied.
    expect(r.root.findByType('TextInput' as any).props.value).toBe('MY EDIT');
    expect(onSaved).not.toHaveBeenCalled();

    // Editing again clears the error.
    TestRenderer.act(() => {
      r.root.findByType('TextInput' as any).props.onChangeText('MY EDIT 2');
    });
    expect(r.root.findAllByProps({ testID: 'context-file-IDENTITY.md-save-error' }).length).toBe(0);
  });

  it('discards an in-flight save whose agent is no longer current', async () => {
    let resolveSave!: (v: unknown) => void;
    apiMock.saveContext.mockImplementation(
      () =>
        new Promise((res) => {
          resolveSave = res;
        }),
    );
    const onSaved = vi.fn();
    const r = create({
      filename: 'IDENTITY.md',
      content: 'AGENT_A_BODY',
      agentId: 'agent-a',
      defaultExpanded: true,
      onSaved,
    });
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Edit' }).parent!.props.onPress();
    });
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Save' }).parent!.props.onPress();
    });
    expect(apiMock.saveContext).toHaveBeenCalledWith(
      'agent-a',
      'IDENTITY.md',
      'AGENT_A_BODY',
      'AGENT_A_BODY',
    );

    // Switch agents while the save is still in flight.
    TestRenderer.act(() => {
      r.update(
        React.createElement(ContextFilePanel, {
          filename: 'IDENTITY.md',
          content: 'AGENT_B_BODY',
          agentId: 'agent-b',
          defaultExpanded: true,
          onSaved,
        }),
      );
    });
    await TestRenderer.act(async () => {
      resolveSave({});
    });

    // The stale completion must not write agent A's buffer into agent B's panel.
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('still applies a save that completes while its agent is current', async () => {
    let resolveSave!: (v: unknown) => void;
    apiMock.saveContext.mockImplementation(
      () =>
        new Promise((res) => {
          resolveSave = res;
        }),
    );
    const onSaved = vi.fn();
    const r = create({
      filename: 'IDENTITY.md',
      content: 'AGENT_A_BODY',
      agentId: 'agent-a',
      defaultExpanded: true,
      onSaved,
    });
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Edit' }).parent!.props.onPress();
    });
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Save' }).parent!.props.onPress();
    });
    // No agent switch — the guard must NOT suppress a legitimate save.
    await TestRenderer.act(async () => {
      resolveSave({});
    });
    expect(onSaved).toHaveBeenCalledWith('IDENTITY.md', 'AGENT_A_BODY');
  });

  it('lets a second agent save while the first agent save is still pending', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    apiMock.saveContext.mockImplementation(
      () =>
        new Promise((res) => {
          resolvers.push(res);
        }),
    );
    const onSaved = vi.fn();
    const r = create({
      filename: 'IDENTITY.md',
      content: 'AGENT_A_BODY',
      agentId: 'agent-a',
      defaultExpanded: true,
      onSaved,
    });
    // Agent A: edit + save, left in flight.
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Edit' }).parent!.props.onPress();
    });
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Save' }).parent!.props.onPress();
    });
    expect(apiMock.saveContext).toHaveBeenNthCalledWith(
      1,
      'agent-a',
      'IDENTITY.md',
      'AGENT_A_BODY',
      'AGENT_A_BODY',
    );

    // Switch to agent B while A's save is still pending.
    TestRenderer.act(() => {
      r.update(
        React.createElement(ContextFilePanel, {
          filename: 'IDENTITY.md',
          content: 'AGENT_B_BODY',
          agentId: 'agent-b',
          defaultExpanded: true,
          onSaved,
        }),
      );
    });
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Edit' }).parent!.props.onPress();
    });
    // B's Save button must NOT be disabled by A's still-pending save.
    const bSaveButton = r.root.findByProps({ children: 'Save' }).parent!;
    expect(bSaveButton.props.disabled).toBeFalsy();

    TestRenderer.act(() => {
      bSaveButton.props.onPress();
    });
    expect(apiMock.saveContext).toHaveBeenNthCalledWith(
      2,
      'agent-b',
      'IDENTITY.md',
      'AGENT_B_BODY',
      'AGENT_B_BODY',
    );

    // B's save resolves first and applies independently.
    await TestRenderer.act(async () => {
      resolvers[1]({});
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith('IDENTITY.md', 'AGENT_B_BODY');

    // A's late completion is stale: it must not call onSaved nor disturb B.
    await TestRenderer.act(async () => {
      resolvers[0]({});
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('treats a save from a prior visit as stale after an A -> B -> A round-trip', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    apiMock.saveContext.mockImplementation(
      () =>
        new Promise((res) => {
          resolvers.push(res);
        }),
    );
    const onSaved = vi.fn();
    const propsA = {
      filename: 'IDENTITY.md',
      content: 'AGENT_A_BODY',
      agentId: 'agent-a',
      defaultExpanded: true,
      onSaved,
    };
    const r = create(propsA);

    // First visit to A: start a save (token 1), leave it pending.
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Edit' }).parent!.props.onPress();
    });
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Save' }).parent!.props.onPress();
    });
    expect(apiMock.saveContext).toHaveBeenNthCalledWith(
      1,
      'agent-a',
      'IDENTITY.md',
      'AGENT_A_BODY',
      'AGENT_A_BODY',
    );

    // Round-trip A -> B -> A; the second visit to A is a new generation.
    TestRenderer.act(() => {
      r.update(
        React.createElement(ContextFilePanel, {
          filename: 'IDENTITY.md',
          content: 'AGENT_B_BODY',
          agentId: 'agent-b',
          defaultExpanded: true,
          onSaved,
        }),
      );
    });
    TestRenderer.act(() => {
      r.update(React.createElement(ContextFilePanel, propsA));
    });

    // Second visit to A: Save not stuck disabled; start a second save (token 2).
    TestRenderer.act(() => {
      r.root.findByProps({ children: 'Edit' }).parent!.props.onPress();
    });
    const save2 = r.root.findByProps({ children: 'Save' }).parent!;
    expect(save2.props.disabled).toBeFalsy();
    TestRenderer.act(() => {
      save2.props.onPress();
    });
    expect(apiMock.saveContext).toHaveBeenNthCalledWith(
      2,
      'agent-a',
      'IDENTITY.md',
      'AGENT_A_BODY',
      'AGENT_A_BODY',
    );

    // The FIRST save resolves: prior generation → no onSaved, and its finally
    // must not clear the second save's still-pending indicator.
    await TestRenderer.act(async () => {
      resolvers[0]({});
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(r.root.findAllByProps({ children: 'Saving…' }).length).toBe(1);

    // The second (current) save then resolves and applies.
    await TestRenderer.act(async () => {
      resolvers[1]({});
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith('IDENTITY.md', 'AGENT_A_BODY');
  });
});
