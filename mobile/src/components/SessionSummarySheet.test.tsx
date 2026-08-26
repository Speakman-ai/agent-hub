import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// React's interactive test renderer requires the development build so effects
// and press handlers can be flushed with act().
process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const testState = vi.hoisted(() => ({
  navigate: vi.fn(),
  getSessionSummary: vi.fn(),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Modal: nativeHost('Modal'),
  Pressable: nativeHost('Pressable'),
  ScrollView: nativeHost('ScrollView'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: testState.navigate }),
}));
vi.mock('../utils/api', () => ({
  api: { getSessionSummary: testState.getSessionSummary },
}));
vi.mock('../utils/engineOptions', () => ({
  modelDisplay: (model: string) => ({ label: model }),
}));
vi.mock('./AppIcon', () => ({ default: nativeHost('AppIcon') }));

const { default: SessionSummarySheet } = await import('./SessionSummarySheet');

async function renderSheet(onClose: () => void) {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <SessionSummarySheet visible onClose={onClose} sessionId="session-1" sessionAgents={[]} />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('mobile SessionSummarySheet ticket navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.getSessionSummary.mockResolvedValue({
      session: { id: 'session-1', name: 'Fix linked tickets' },
      projectId: 'project-1',
      linkedCard: {
        id: 'card-42',
        title: 'Open the exact ticket',
        columnName: 'In Progress',
      },
      skills: [],
    });
  });

  it('closes the sheet and opens the linked Kanban card when the ticket is tapped', async () => {
    const onClose = vi.fn();
    const renderer = await renderSheet(onClose);
    const ticket = renderer.root.findByProps({
      accessibilityLabel: 'Open ticket Open the exact ticket',
    });

    TestRenderer.act(() => ticket.props.onPress());

    expect(onClose).toHaveBeenCalledOnce();
    expect(testState.navigate).toHaveBeenCalledOnce();
    expect(testState.navigate).toHaveBeenCalledWith('Kanban', {
      projectId: 'project-1',
      cardId: 'card-42',
    });
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      testState.navigate.mock.invocationCallOrder[0],
    );
  });
});
