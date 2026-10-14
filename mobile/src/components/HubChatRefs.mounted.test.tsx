import { describe, expect, it, vi } from 'vitest';
import type { ComposerMention } from '@shared/utils/hubChatRefs';

vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn() },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-markdown-display', () => ({
  default: () => null,
  MarkdownIt: () => ({ use: () => ({}) }),
}));
vi.mock('../utils/api', () => ({
  api: { hubChat: { searchRefs: vi.fn().mockResolvedValue({ suggestions: [] }) } },
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { HubChatComposer } = await import('./HubChatRefs');
process.env.NODE_ENV = originalNodeEnv;

const BOB: ComposerMention = { display: '@bob', token: '@[bob](user:u1)', at: 0 };

/** A controlled composer like the channel view's, recording every change. */
function Harness({ onChange }: { onChange: (t: string, m: ComposerMention[]) => void }) {
  const [state, setState] = React.useState({ text: '@bob ', mentions: [BOB] });
  return React.createElement(HubChatComposer, {
    value: state.text,
    mentions: state.mentions,
    onChange: (text: string, mentions: ComposerMention[]) => {
      setState({ text, mentions });
      onChange(text, mentions);
    },
  });
}

async function mount() {
  const onChange = vi.fn();
  let r: any;
  await act(async () => {
    r = TestRenderer.create(React.createElement(Harness, { onChange }));
  });
  const input = () => r.root.findByType('TextInput');
  return { r, onChange, input };
}

const select = (input: any, n: number) =>
  act(async () => {
    input().props.onSelectionChange({ nativeEvent: { selection: { start: n, end: n } } });
  });
const type = (input: any, text: string) =>
  act(async () => {
    input().props.onChangeText(text);
  });

describe('HubChatComposer edits with repeated text (mounted)', () => {
  it('prefix paste, new caret reported before the text: mention moves to the second copy', async () => {
    const { r, onChange, input } = await mount();
    await select(input, 0); // caret moved to the start
    await select(input, 5); // the paste's resulting caret, reported first
    await type(input, '@bob @bob ');
    expect(onChange).toHaveBeenLastCalledWith('@bob @bob ', [{ ...BOB, at: 5 }]);
    r.unmount();
  });

  it('prefix paste, new caret reported after the text: same result', async () => {
    const { r, onChange, input } = await mount();
    await select(input, 0);
    await type(input, '@bob @bob ');
    await select(input, 5);
    expect(onChange).toHaveBeenLastCalledWith('@bob @bob ', [{ ...BOB, at: 5 }]);
    r.unmount();
  });

  it('append, new caret reported after the text: mention stays on the first copy', async () => {
    const { r, onChange, input } = await mount();
    await select(input, 5);
    await type(input, '@bob @bob ');
    await select(input, 10);
    expect(onChange).toHaveBeenLastCalledWith('@bob @bob ', [BOB]);
    r.unmount();
  });

  it('append, new caret reported before the text: mention stays on the first copy', async () => {
    const { r, onChange, input } = await mount();
    await select(input, 5);
    await select(input, 10);
    await type(input, '@bob @bob ');
    expect(onChange).toHaveBeenLastCalledWith('@bob @bob ', [BOB]);
    r.unmount();
  });

  it('typing before the mention shifts it rather than dropping it', async () => {
    const { r, onChange, input } = await mount();
    await select(input, 0);
    await type(input, 'hi @bob ');
    expect(onChange).toHaveBeenLastCalledWith('hi @bob ', [{ ...BOB, at: 3 }]);
    r.unmount();
  });
});

describe('HubChatComposer when the draft is replaced from outside (mounted)', () => {
  const BOB_SUGGESTION = {
    kind: 'user',
    targetId: 'u1',
    label: 'bob',
    detail: null,
    projectId: null,
  };

  /** The channel view's composer: it clears or swaps the draft itself. */
  let replace: (text: string, mentions?: ComposerMention[]) => void = () => {};
  function OwnedDraft({ onChange }: { onChange: (t: string, m: ComposerMention[]) => void }) {
    const [state, setState] = React.useState({ text: '', mentions: [] as ComposerMention[] });
    replace = (text, mentions = []) => setState({ text, mentions });
    return React.createElement(HubChatComposer, {
      value: state.text,
      mentions: state.mentions,
      onChange: (text: string, mentions: ComposerMention[]) => {
        setState({ text, mentions });
        onChange(text, mentions);
      },
    });
  }

  async function withOpenPopup() {
    const { api } = (await import('../utils/api')) as any;
    api.hubChat.searchRefs.mockResolvedValue({ suggestions: [BOB_SUGGESTION] });
    const onChange = vi.fn();
    let r: any;
    await act(async () => {
      r = TestRenderer.create(React.createElement(OwnedDraft, { onChange }));
    });
    const input = () => r.root.findByType('TextInput');
    await act(async () => {
      input().props.onChangeText('hi @bo');
    });
    // Past the search debounce.
    await act(async () => {
      await new Promise((res) => setTimeout(res, 200));
    });
    const popup = () => r.root.findAll((n: any) => n.props?.testID === 'hub-chat-mention-popup');
    expect(popup().length).toBeGreaterThan(0);
    const option = r.root.findAll(
      (n: any) => n.props?.accessibilityLabel === 'Person bob' && n.props.onPress,
    )[0];
    // The handler a tap already in flight would run, captured before the popup can close.
    const press: () => void = option.props.onPress;
    return { r, onChange, popup, press, input };
  }

  it('sending (draft cleared) closes the popup, and a stale pick inserts nothing', async () => {
    const { r, onChange, popup, press } = await withOpenPopup();
    onChange.mockClear();
    await act(async () => replace(''));
    expect(popup()).toHaveLength(0);
    await act(async () => press());
    expect(onChange).not.toHaveBeenCalled();
    expect(r.root.findByType('TextInput').props.value).toBe('');
    r.unmount();
  });

  it('opening another message to edit closes the popup and keeps its text intact', async () => {
    const { r, onChange, popup, press } = await withOpenPopup();
    onChange.mockClear();
    await act(async () => replace('fix the build'));
    expect(popup()).toHaveLength(0);
    await act(async () => press());
    expect(onChange).not.toHaveBeenCalled();
    expect(r.root.findByType('TextInput').props.value).toBe('fix the build');
    r.unmount();
  });

  it('a pick on the text it was offered for still inserts the mention', async () => {
    const { r, onChange, press } = await withOpenPopup();
    await act(async () => press());
    expect(onChange).toHaveBeenLastCalledWith('hi @bob ', [
      { display: '@bob', token: '@[bob](user:u1)', at: 3 },
    ]);
    r.unmount();
  });
});
