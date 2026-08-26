import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

// Capture the callback the screen registers for `initial_build_started`, plus
// the app-level setters/navigation so the test can assert the session handoff.
const testState = vi.hoisted(() => ({
  app: {
    refreshProjects: vi.fn(),
    refreshAgents: vi.fn(),
    setActiveAgentId: vi.fn(),
    setActiveSessionId: vi.fn(),
    subscribeInitialBuild: vi.fn(),
  },
  api: { provisionProject: vi.fn(), getProject: vi.fn() },
  initialBuildCb: null as null | ((data: any) => void),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: nativeHost('SafeAreaView') }));
vi.mock('../context/AppContext', () => ({ useApp: () => testState.app }));
vi.mock('../utils/api', () => ({ api: testState.api }));
vi.mock('../utils/newProjectProvisioning', () => ({ isCompleteProject: () => true }));
// Expose the questionnaire's onSubmit via a pressable so the test can drive it.
vi.mock('../components/AdaptiveQuestionnaire', () => ({
  default: ({ onSubmit }: any) =>
    React.createElement('TouchableOpacity', {
      testID: 'submit-questionnaire',
      onPress: () => onSubmit({ name: 'widget', hostOnAgentHub: false }),
    }),
}));

const { default: NewProjectScreen } = await import('./NewProjectScreen');

async function renderScreen(navigation: any) {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(<NewProjectScreen navigation={navigation} />);
    await Promise.resolve();
  });
  return renderer;
}

describe('NewProjectScreen first-build handoff', () => {
  it('opens the first build session when initial_build_started arrives', async () => {
    const navigation = { goBack: vi.fn(), navigate: vi.fn() };
    testState.app.setActiveAgentId.mockReset();
    testState.app.setActiveSessionId.mockReset();
    testState.app.subscribeInitialBuild.mockReset().mockImplementation((cb: any) => {
      testState.initialBuildCb = cb;
      return () => {
        testState.initialBuildCb = null;
      };
    });
    testState.api.provisionProject
      .mockReset()
      .mockResolvedValue({ projectId: 'widget', jobId: 'job-1', wsUrl: 'ws://x' });
    testState.api.getProject.mockReset().mockResolvedValue({ id: 'widget', name: 'widget' });

    const renderer = await renderScreen(navigation);

    // Kick off provisioning through the questionnaire.
    await TestRenderer.act(async () => {
      renderer.root.findByProps({ testID: 'submit-questionnaire' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testState.initialBuildCb).toBeTypeOf('function');

    // The provisioning job dispatches the first build session.
    await TestRenderer.act(async () => {
      testState.initialBuildCb?.({
        type: 'initial_build_started',
        projectId: 'widget',
        sessionId: 'sess-build-1',
        agentId: 'widget-dev',
      });
      await Promise.resolve();
    });

    expect(testState.app.setActiveAgentId).toHaveBeenCalledWith('widget-dev');
    expect(testState.app.setActiveSessionId).toHaveBeenCalledWith('sess-build-1');
    expect(navigation.navigate).toHaveBeenCalledWith('Chat');
  });

  it('ignores initial_build_started for a different project', async () => {
    const navigation = { goBack: vi.fn(), navigate: vi.fn() };
    testState.app.setActiveSessionId.mockReset();
    testState.app.subscribeInitialBuild.mockReset().mockImplementation((cb: any) => {
      testState.initialBuildCb = cb;
      return () => {
        testState.initialBuildCb = null;
      };
    });
    testState.api.provisionProject
      .mockReset()
      .mockResolvedValue({ projectId: 'widget', jobId: 'job-1', wsUrl: 'ws://x' });
    testState.api.getProject.mockReset().mockResolvedValue({ id: 'widget', name: 'widget' });

    const renderer = await renderScreen(navigation);
    await TestRenderer.act(async () => {
      renderer.root.findByProps({ testID: 'submit-questionnaire' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await TestRenderer.act(async () => {
      testState.initialBuildCb?.({
        type: 'initial_build_started',
        projectId: 'other-project',
        sessionId: 'sess-other',
        agentId: 'other-dev',
      });
      await Promise.resolve();
    });

    expect(testState.app.setActiveSessionId).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});
