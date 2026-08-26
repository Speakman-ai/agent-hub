import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

const apiMock = vi.hoisted(() => ({
  addSessionAgent: vi.fn(),
  removeSessionAgent: vi.fn(),
  setSessionAgentModel: vi.fn(),
  getSessionDetail: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../utils/api', () => ({ api: apiMock }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { default: SessionAgentsPanel } = await import('./SessionAgentsPanel');
process.env.NODE_ENV = originalNodeEnv;

const sessionAgents = [
  {
    participantId: 'executor:agent-1',
    id: 'agent-1',
    name: 'Lead',
    role: 'executor',
    engine: 'claude-code',
    model: 'model-a',
    projectId: 'project-1',
  },
  {
    participantId: 'participant-1',
    id: 'agent-2',
    name: 'Helper',
    role: 'advisor',
    engine: 'claude-code',
    model: 'model-a',
    projectId: 'project-1',
  },
];
const agents = [
  { id: 'agent-1', name: 'Lead', engine: 'claude-code', projectId: 'project-1' },
  { id: 'agent-2', name: 'Helper', engine: 'claude-code', projectId: 'project-1' },
];

describe('SessionAgentsPanel mobile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSessionDetail.mockResolvedValue({ id: 'session-1' });
  });

  it('adds a duplicate agent with its selected model', async () => {
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        React.createElement(SessionAgentsPanel, {
          sessionId: 'session-1',
          sessionAgents,
          agents,
          modelConfig: { engineValidModels: { 'claude-code': ['model-a', 'model-b'] } },
        }),
      );
    });

    await TestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Toggle session agents' }).props.onPress();
    });
    await TestRenderer.act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Use model-b for new Helper' })
        .props.onPress();
    });
    await TestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Add Helper' }).props.onPress();
    });

    expect(apiMock.addSessionAgent).toHaveBeenCalledWith('session-1', 'agent-2', 'model-b');
  });

  it('updates one duplicate participant by participant id', async () => {
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        React.createElement(SessionAgentsPanel, {
          sessionId: 'session-1',
          sessionAgents,
          agents,
          modelConfig: { engineValidModels: { 'claude-code': ['model-a', 'model-b'] } },
        }),
      );
    });
    await TestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Toggle session agents' }).props.onPress();
    });
    await TestRenderer.act(async () => {
      await renderer.root
        .findByProps({ accessibilityLabel: 'Use model-b for Helper' })
        .props.onPress();
    });

    expect(apiMock.setSessionAgentModel).toHaveBeenCalledWith(
      'session-1',
      'participant-1',
      'model-b',
    );
  });
});
