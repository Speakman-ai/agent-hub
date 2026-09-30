import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const act = TestRenderer.act as (cb: () => unknown) => Promise<void>;

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  FlatList: 'FlatList',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Alert: { alert: vi.fn() },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
  Modal: 'Modal',
  Image: 'Image',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('react-native-markdown-display', () => ({ default: 'Markdown' }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('../components/AppIcon', () => ({ default: 'AppIcon' }));
vi.mock('../utils/api', () => ({
  api: { getNotes: vi.fn(async () => []), summarizeVoiceTranscript: vi.fn() },
}));
vi.mock('../utils/config', () => ({ getServerBaseUrl: () => 'https://hub.test' }));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({ projects: [{ id: 'p1', name: 'P1' }] }),
}));

// Capture the options NotesScreen hands the hook so the test can drive errors.
const voice = vi.hoisted(() => ({
  opts: null as any,
  handleMicClick: vi.fn(),
  cancel: vi.fn(),
  trackEdit: vi.fn(),
}));
vi.mock('../hooks/useVoiceTranscription', () => ({
  useVoiceTranscription: (opts: any) => {
    voice.opts = opts;
    return {
      isRecording: false,
      isTranscribing: false,
      micDisabled: false,
      handleMicClick: voice.handleMicClick,
      cancel: voice.cancel,
      trackEdit: voice.trackEdit,
    };
  },
}));

const { default: NotesScreen } = await import('./NotesScreen');
const { api } = await import('../utils/api');
const { buildVoiceNoteMarkdown } = await import('@shared/utils/voiceNoteMarkdown');

function textOf(renderer: any): string[] {
  return renderer.root
    .findAll((n: any) => n.type === 'Text')
    .map((n: any) => [].concat(n.props.children).join(''));
}

async function openNewNote() {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(NotesScreen, { route: {} }));
  });
  const add = renderer.root.findAll(
    (n: any) =>
      n.type === 'TouchableOpacity' &&
      n.findAll((c: any) => c.type === 'Text' && c.props.children === '+').length > 0,
  )[0];
  await act(async () => {
    add.props.onPress();
  });
  return renderer;
}

describe('NotesScreen voice input', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows voice errors inline and clears them when dictation starts again', async () => {
    const renderer = await openNewNote();
    await act(async () => {
      voice.opts.onError('Microphone permission denied.');
    });
    expect(textOf(renderer)).toContain('Microphone permission denied.');

    const mic = renderer.root.find(
      (n: any) => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === 'Voice input',
    );
    await act(async () => {
      mic.props.onPress();
    });
    expect(voice.handleMicClick).toHaveBeenCalledTimes(1);
    expect(textOf(renderer)).not.toContain('Microphone permission denied.');
  });

  it('feeds typed edits to the dictation anchor', async () => {
    const renderer = await openNewNote();
    const input = renderer.root.find(
      (n: any) =>
        n.type === 'TextInput' && n.props.placeholder === 'Write your note in markdown...',
    );
    await act(async () => {
      input.props.onChangeText('abc');
    });
    expect(voice.trackEdit).toHaveBeenCalledWith('', 'abc');
  });

  it('summarizes a dictated transcript and folds the original below it', async () => {
    await openNewNote();
    (api.summarizeVoiceTranscript as any).mockResolvedValueOnce({
      summary: '**Call Bob.**',
      engine: 'claude-code',
      model: 'm',
    });
    const out = await voice.opts.prepareTranscript('uh call bob');
    expect(api.summarizeVoiceTranscript).toHaveBeenCalledWith('uh call bob');
    expect(out).toBe(
      buildVoiceNoteMarkdown({ summary: '**Call Bob.**', transcript: 'uh call bob' }),
    );
  });

  it('keeps the folded transcript and reports the error when summarizing fails', async () => {
    const renderer = await openNewNote();
    (api.summarizeVoiceTranscript as any).mockRejectedValueOnce(new Error('503: no engines'));
    let out = '';
    await act(async () => {
      out = await voice.opts.prepareTranscript('just words');
    });
    expect(out).toBe(buildVoiceNoteMarkdown({ transcript: 'just words' }));
    expect(textOf(renderer).some((t) => t.includes("Couldn't summarize the recording"))).toBe(true);
  });
});
