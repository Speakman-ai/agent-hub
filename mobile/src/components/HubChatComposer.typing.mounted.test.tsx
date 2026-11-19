import { describe, expect, it, vi } from 'vitest';

// A TextInput stand-in that records the props of every render, so a test can
// see whether a `selection` was ever sent to the native field.
const inputRenders: any[] = [];
vi.mock('react-native', () => {
  function TextInput(props: any) {
    inputRenders.push(props);
    return null;
  }
  return {
    Linking: { openURL: vi.fn() },
    ScrollView: 'ScrollView',
    StyleSheet: { create: (s: any) => s },
    Text: 'Text',
    TextInput,
    TouchableOpacity: 'TouchableOpacity',
    View: 'View',
    Platform: { OS: 'ios' },
    Image: 'Image',
    Alert: { alert: vi.fn() },
    ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
    ActivityIndicator: 'ActivityIndicator',
  };
});
vi.mock('react-native-markdown-display', () => ({
  default: () => null,
  MarkdownIt: () => ({ use: () => ({}) }),
}));
vi.mock('../utils/api', () => ({
  api: { hubChat: { searchRefs: vi.fn().mockResolvedValue({ suggestions: [] }) } },
}));
vi.mock('./AppIcon', () => ({ default: () => null }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-document-picker', () => ({}));
vi.mock('../hooks/useVoiceTranscription', () => ({
  useVoiceTranscription: () => ({
    isRecording: false,
    isTranscribing: false,
    micDisabled: true,
    handleMicClick: () => {},
  }),
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { HubChatComposer } = await import('./HubChatRefs');
const MessageInput = (await import('./MessageInput')).default;
process.env.NODE_ENV = originalNodeEnv;

const lastInput = () => inputRenders[inputRenders.length - 1];
const selections = () => inputRenders.map((p) => p.selection);

/** Fire native events back to back, the way a burst lands before React re-renders. */
async function burst(...events: Array<(props: any) => void>) {
  const props = lastInput();
  await act(async () => {
    for (const fire of events) fire(props);
  });
}
const text = (t: string) => (p: any) => p.onChangeText(t);
const caret = (n: number) => (p: any) =>
  p.onSelectionChange({ nativeEvent: { selection: { start: n, end: n } } });

async function mountMessageInput(skills: any[] = []) {
  inputRenders.length = 0;
  let r: any;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(MessageInput, { onSend: vi.fn(), skills, disabled: false }),
    );
  });
  return r;
}

describe('chat composer typing (mounted)', () => {
  it('keeps an autocorrect replacement that lands back on the last rendered text', async () => {
    const r = await mountMessageInput();
    await burst(text('I saw teh'), caret(9));
    // A burst before React re-renders: a space, the keyboard's correction,
    // then the user taps the correction away, back to the rendered text.
    await burst(text('I saw teh '), text('I saw the '), caret(10), text('I saw teh'), caret(9));
    expect(lastInput().value).toBe('I saw teh');
    r.unmount();
  });

  it('keeps a mid-word replacement and its caret move without reverting it', async () => {
    const r = await mountMessageInput();
    await burst(text('helo world'), caret(10));
    await burst(caret(4), text('hello world'), caret(5));
    expect(lastInput().value).toBe('hello world');
    await burst(text('hello world!'), caret(12));
    expect(lastInput().value).toBe('hello world!');
    r.unmount();
  });

  it('never sends a selection to the native field while typing', async () => {
    const r = await mountMessageInput();
    for (const t of ['h', 'he', 'hel', 'hell', 'hello']) {
      await burst(text(t), caret(t.length));
    }
    await burst(caret(2), text('heyllo'), caret(3));
    expect(selections().every((s) => s === undefined)).toBe(true);
    r.unmount();
  });

  it('places the caret once after a slash command is inserted', async () => {
    const r = await mountMessageInput([{ id: 'kanban', name: 'kanban' }]);
    await burst(text('/ka'), caret(3));
    const pick = r.root
      .findAll((n: any) => n.type === 'TouchableOpacity' && n.props.onPress)
      .find(
        (n: any) =>
          n.findAll((c: any) => c.type === 'Text' && c.props.children === 'kanban').length,
      );
    expect(pick).toBeTruthy();
    const before = inputRenders.length;
    await act(async () => pick.props.onPress());
    const after = inputRenders.slice(before);
    expect(lastInput().value).toBe('/kanban ');
    const placed = after.filter((p) => p.selection);
    expect(placed).toHaveLength(1);
    expect(placed[0].selection).toEqual({ start: 8, end: 8 });
    expect(lastInput().selection).toBeUndefined();
    r.unmount();
  });
});

describe('HubChatComposer caret placement (mounted)', () => {
  it('sends the caret after a mention pick for one render only', async () => {
    const { api } = (await import('../utils/api')) as any;
    api.hubChat.searchRefs.mockResolvedValue({
      suggestions: [{ kind: 'user', targetId: 'u1', label: 'bob', detail: null, projectId: null }],
    });
    inputRenders.length = 0;
    function Draft() {
      const [state, setState] = React.useState({ text: '', mentions: [] as any[] });
      return React.createElement(HubChatComposer, {
        value: state.text,
        mentions: state.mentions,
        onChange: (t: string, m: any[]) => setState({ text: t, mentions: m }),
      });
    }
    let r: any;
    await act(async () => {
      r = TestRenderer.create(React.createElement(Draft));
    });
    await burst(text('hi @bo'), caret(6));
    await act(async () => {
      await new Promise((res) => setTimeout(res, 200));
    });
    const option = r.root.findAll(
      (n: any) => n.props?.accessibilityLabel === 'Person bob' && n.props.onPress,
    )[0];
    const before = inputRenders.length;
    await act(async () => option.props.onPress());
    const placed = inputRenders.slice(before).filter((p) => p.selection);
    expect(lastInput().value).toBe('hi @bob ');
    expect(placed).toHaveLength(1);
    expect(placed[0].selection).toEqual({ start: 8, end: 8 });
    expect(lastInput().selection).toBeUndefined();
    // Typing afterwards never re-sends it.
    const mark = inputRenders.length;
    await burst(text('hi @bob y'), caret(9));
    expect(inputRenders.slice(mark).every((p) => p.selection === undefined)).toBe(true);
    r.unmount();
  });
});
