import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';

// Vitest inherits NODE_ENV=production in Agent Hub's test runner. Load the
// development React renderer explicitly so hooks can be flushed interactively.
process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

vi.mock('react-native', () => ({
  ScrollView: nativeHost('ScrollView'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TextInput: nativeHost('TextInput'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));

vi.mock('../utils/api', () => ({
  api: { suggestProjectSetup: vi.fn(() => Promise.resolve({})) },
}));

const { default: AdaptiveQuestionnaire, buildSuggestionPatch } =
  await import('./AdaptiveQuestionnaire');
const { api } = await import('../utils/api');

const suggestProjectSetup = vi.mocked(api.suggestProjectSetup);

async function renderQuestionnaire(props: Record<string, any> = {}) {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <AdaptiveQuestionnaire onSubmit={vi.fn()} onClose={vi.fn()} {...props} />,
    );
  });
  return renderer;
}

async function flushEffects() {
  await TestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function press(renderer: ReactTestRenderer, testID: string) {
  const control = renderer.root.findByProps({ testID });
  TestRenderer.act(() => control.props.onPress());
}

function changeText(renderer: ReactTestRenderer, testID: string, value: string) {
  const control = renderer.root.findByProps({ testID });
  TestRenderer.act(() => control.props.onChangeText(value));
}

const reviewDraft = {
  step: 3,
  description: 'a tool',
  hosting: 'agenthub',
  name: 'tool',
  visibility: 'private',
};

describe('mobile AdaptiveQuestionnaire', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks an empty description and advances through the native questionnaire', async () => {
    const renderer = await renderQuestionnaire();
    expect(renderer.root.findByProps({ testID: 'aq-continue' }).props.disabled).toBe(true);

    changeText(renderer, 'aq-description-input', 'a survey tool');
    press(renderer, 'aq-continue');
    expect(renderer.root.findByProps({ testID: 'aq-step-hosting' })).toBeTruthy();

    press(renderer, 'aq-hosting-agenthub');
    press(renderer, 'aq-continue');
    expect(renderer.root.findByProps({ testID: 'aq-step-identity' })).toBeTruthy();
  });

  it('does not loop after an empty suggestion response and exposes retry', async () => {
    suggestProjectSetup.mockResolvedValueOnce({});
    const renderer = await renderQuestionnaire({ initial: { ...reviewDraft, name: 'idk' } });
    await flushEffects();

    expect(suggestProjectSetup).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ testID: 'aq-suggest-retry' })).toBeTruthy();
    await flushEffects();
    expect(suggestProjectSetup).toHaveBeenCalledTimes(1);
  });

  it('applies a name suggestion once', async () => {
    suggestProjectSetup.mockResolvedValueOnce({ name: 'Suggested Tool' });
    const renderer = await renderQuestionnaire({
      initial: { ...reviewDraft, name: 'idk' },
    });
    await flushEffects();

    expect(suggestProjectSetup).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ testID: 'aq-suggest-retry' })).toHaveLength(0);
  });

  it('rejects unsupported model values instead of putting them in the provisioning draft', () => {
    expect(buildSuggestionPatch({ name: 'idk' }, {}, true)).toEqual({});

    expect(buildSuggestionPatch({ name: '  Safe Tool ' }, {}, true)).toEqual({
      name: 'Safe Tool',
    });
  });

  it('submits at most once when the final action is double-tapped', async () => {
    const onSubmit = vi.fn();
    const renderer = await renderQuestionnaire({ initial: reviewDraft, onSubmit });

    press(renderer, 'aq-submit');
    press(renderer, 'aq-submit');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('disables the final action while the parent is provisioning', async () => {
    const onSubmit = vi.fn();
    const renderer = await renderQuestionnaire({
      initial: reviewDraft,
      submitting: true,
      onSubmit,
    });

    const submit = renderer.root.findByProps({ testID: 'aq-submit' });
    expect(submit.props.disabled).toBe(true);
    press(renderer, 'aq-submit');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
