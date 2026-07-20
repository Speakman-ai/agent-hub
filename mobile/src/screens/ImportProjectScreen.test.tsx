import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const testState = vi.hoisted(() => ({
  app: {
    modelConfig: {
      engineValidModels: { 'claude-code': ['claude-model'], 'cursor-agent': ['cursor-model'] },
      engineDefaultModels: { 'claude-code': 'claude-model', 'cursor-agent': 'cursor-model' },
    },
    projectImportEvents: [] as any[],
    refreshProjects: vi.fn(),
    refreshAgents: vi.fn(),
  },
  api: { analyzeProject: vi.fn() },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  Alert: { alert: vi.fn() },
  ScrollView: nativeHost('ScrollView'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TextInput: nativeHost('TextInput'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: nativeHost('SafeAreaView') }));
vi.mock('../context/AppContext', () => ({ useApp: () => testState.app }));
vi.mock('../utils/api', () => ({ api: testState.api }));
vi.mock('../utils/oauthSignIn', () => ({ signInWithGithub: vi.fn() }));

const { default: ImportProjectScreen } = await import('./ImportProjectScreen');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function press(renderer: ReactTestRenderer, testID: string) {
  const control = renderer.root.findByProps({ testID });
  TestRenderer.act(() => control.props.onPress());
}

function changeText(renderer: ReactTestRenderer, testID: string, value: string) {
  const control = renderer.root.findByProps({ testID });
  TestRenderer.act(() => control.props.onChangeText(value));
}

function screenElement(navigation: any) {
  return <ImportProjectScreen navigation={navigation} />;
}

async function renderScreen(navigation: any) {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(screenElement(navigation));
    await Promise.resolve();
  });
  return renderer;
}

async function rerender(renderer: ReactTestRenderer, navigation: any) {
  await TestRenderer.act(async () => {
    renderer.update(screenElement(navigation));
    await Promise.resolve();
  });
}

describe('ImportProjectScreen analysis recovery', () => {
  it('offers retry after failure and after changing the analysis configuration', async () => {
    const navigation = { goBack: vi.fn(), navigate: vi.fn() };
    const request = deferred<{ analyzeId: string }>();
    testState.api.analyzeProject.mockReset().mockReturnValueOnce(request.promise);
    testState.app.projectImportEvents = [];
    const renderer = await renderScreen(navigation);

    changeText(renderer, 'import-path', '/tmp/tool');
    press(renderer, 'import-continue');
    await TestRenderer.act(async () => {
      request.resolve({ analyzeId: 'analysis-1' });
      await Promise.resolve();
    });

    testState.app.projectImportEvents = [
      { importEventId: 1, analyzeId: 'analysis-1', type: 'analyze-error', error: 'failed' },
    ];
    await rerender(renderer, navigation);
    expect(renderer.root.findByProps({ testID: 'import-analyze' }).props.disabled).toBe(false);

    press(renderer, 'import-analysis-engine-cursor-agent');
    expect(renderer.root.findByProps({ testID: 'import-analyze' }).props.disabled).toBe(false);
  });

  it('ignores a late HTTP response from an older analysis request', async () => {
    const navigation = { goBack: vi.fn(), navigate: vi.fn() };
    const first = deferred<{ analyzeId: string }>();
    const second = deferred<{ analyzeId: string }>();
    testState.api.analyzeProject
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    testState.app.projectImportEvents = [];
    const renderer = await renderScreen(navigation);

    changeText(renderer, 'import-path', '/tmp/tool');
    press(renderer, 'import-continue');
    // Invoke the handler a second time to model a duplicate start before the
    // first HTTP response settles. The generation guard must keep the newer run active.
    press(renderer, 'import-continue');
    expect(testState.api.analyzeProject).toHaveBeenCalledTimes(2);

    await TestRenderer.act(async () => {
      second.resolve({ analyzeId: 'analysis-new' });
      await Promise.resolve();
      first.resolve({ analyzeId: 'analysis-old' });
      await Promise.resolve();
    });

    testState.app.projectImportEvents = [
      {
        importEventId: 2,
        analyzeId: 'analysis-old',
        type: 'analyze-complete',
        result: { agents: [{ id: 'old-agent' }] },
      },
    ];
    await rerender(renderer, navigation);
    expect(() => renderer.root.findByProps({ children: 'Analysis ready' })).toThrow();

    testState.app.projectImportEvents = [
      {
        importEventId: 3,
        analyzeId: 'analysis-new',
        type: 'analyze-complete',
        result: { agents: [] },
      },
    ];
    await rerender(renderer, navigation);
    expect(renderer.root.findByProps({ children: 'Analysis ready' })).toBeTruthy();
  });

  it('invalidates analysis when the source path changes after navigating back', async () => {
    const navigation = { goBack: vi.fn(), navigate: vi.fn() };
    const first = deferred<{ analyzeId: string }>();
    const second = deferred<{ analyzeId: string }>();
    testState.api.analyzeProject
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    testState.app.projectImportEvents = [];
    const renderer = await renderScreen(navigation);

    changeText(renderer, 'import-path', '/tmp/old-tool');
    press(renderer, 'import-continue');
    await TestRenderer.act(async () => {
      first.resolve({ analyzeId: 'analysis-old-source' });
      await Promise.resolve();
    });
    press(renderer, 'import-back');
    changeText(renderer, 'import-path', '/tmp/new-tool');
    press(renderer, 'import-continue');
    await TestRenderer.act(async () => {
      second.resolve({ analyzeId: 'analysis-new-source' });
      await Promise.resolve();
    });

    testState.app.projectImportEvents = [
      {
        importEventId: 4,
        analyzeId: 'analysis-old-source',
        type: 'analyze-complete',
        result: { agents: [{ id: 'stale-agent' }] },
      },
    ];
    await rerender(renderer, navigation);
    expect(() => renderer.root.findByProps({ children: 'Analysis ready' })).toThrow();
  });
});
