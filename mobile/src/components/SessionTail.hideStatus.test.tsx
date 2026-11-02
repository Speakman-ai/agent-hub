import { describe, expect, it, vi } from 'vitest';

/**
 * The simple chat hides done/cost/duration on native replies, in both the
 * collapsed summary and the expanded timeline, while question prompts stay.
 */

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  Image: 'Image',
  Linking: { openURL: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-markdown-display', () => ({ default: () => null }));
vi.mock('../utils/api', () => ({ api: {} }));
vi.mock('./DiffView', () => ({ default: () => null }));
vi.mock('./SubagentCard', () => ({ default: () => null }));
vi.mock('./AskUserQuestion', () => ({ default: () => 'ask-question' }));
vi.mock('./CredentialRequestPrompt', () => ({ default: () => 'credential-request' }));
vi.mock('./BrowserActivityPanel', () => ({ default: () => null }));

process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = TestRenderer;
const { default: SessionTail } = await import('./SessionTail');

const message = { id: 'm1', session_id: 's1', role: 'assistant' };
const events = [
  { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
  { type: 'result', durationMs: 4200, costUsd: 0.1234, numTurns: 2 },
  {
    type: 'ask_user_question',
    askId: 'ask-1',
    questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
  },
].map((event, seq) => ({ seq, event }));

async function renderTail(hideStatus: boolean) {
  let renderer: ReturnType<typeof TestRenderer.create> | undefined;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(SessionTail, { message, events, hideStatus }),
    );
  });
  return renderer!;
}

function text(renderer: ReturnType<typeof TestRenderer.create>) {
  return JSON.stringify(renderer.toJSON());
}

async function expand(renderer: ReturnType<typeof TestRenderer.create>) {
  const bar = renderer.root.find(
    (node) => String(node.type) === 'TouchableOpacity' && typeof node.props.onPress === 'function',
  );
  await act(async () => {
    bar.props.onPress();
  });
}

describe('native SessionTail hideStatus', () => {
  it('shows duration and cost on a completed reply by default', async () => {
    const renderer = await renderTail(false);
    expect(text(renderer)).toContain('$0.1234');
    await expand(renderer);
    expect(text(renderer)).toContain('done');
    expect(text(renderer)).toContain('$0.1234');
  });

  it('hides done, duration, and cost in both layouts but keeps the question', async () => {
    const renderer = await renderTail(true);
    expect(text(renderer)).not.toContain('$0.1234');
    expect(text(renderer)).not.toContain('4.2s');
    expect(text(renderer)).toContain('ask-question');
    await expand(renderer);
    expect(text(renderer)).not.toContain('$0.1234');
    expect(text(renderer)).not.toContain('done');
  });
});
