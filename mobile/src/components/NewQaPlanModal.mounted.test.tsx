/**
 * Mobile New QA plan: picking a QA environment from settings fills the target URL.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));

const env = (id: string, name: string, baseUrl: string) => ({
  id,
  projectId: 'p1',
  name,
  baseUrl,
  notes: '',
  accounts: [],
  position: 0,
  createdAt: '',
  updatedAt: '',
});
const createQaPlan = vi.fn(async () => ({ plan: { id: 'plan-1' } }));
vi.mock('../utils/api', () => ({
  api: {
    getEpics: vi.fn(async () => []),
    getBoardCards: vi.fn(async () => []),
    listQaEnvironments: vi.fn(async () => ({
      environments: [
        env('dev', 'Dev', 'https://dev.example.com'),
        env('stg', 'Staging', 'https://staging.example.com'),
      ],
    })),
    createQaPlan: (...a: unknown[]) => (createQaPlan as any)(...a),
  },
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: NewQaPlanModal } = await import('./NewQaPlanModal');
process.env.NODE_ENV = originalNodeEnv;

describe('mobile NewQaPlanModal environment picker', () => {
  it('defaults to the first environment and fills the URL from the picked one', async () => {
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(
        <NewQaPlanModal projectId="p1" onClose={vi.fn()} onCreated={vi.fn()} />,
      );
    });
    const byId = (id: string) =>
      tree.root.find((n: any) => n.type === 'TouchableOpacity' && n.props.testID === id);
    const target = () =>
      tree.root.find((n: any) => n.type === 'TextInput' && n.props.testID === 'qa-new-target');

    expect(target().props.value).toBe('https://dev.example.com');

    await act(async () => byId('qa-new-environment-stg').props.onPress());
    expect(target().props.value).toBe('https://staging.example.com');

    await act(async () => byId('qa-new-environment-custom').props.onPress());
    expect(target().props.value).toBe('');

    await act(async () => byId('qa-new-environment-stg').props.onPress());
    const title = tree.root.find(
      (n: any) => n.type === 'TextInput' && n.props.testID === 'qa-new-title',
    );
    await act(async () => title.props.onChangeText('Smoke'));
    await act(async () => byId('qa-new-submit').props.onPress());
    expect(createQaPlan).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ targetUrl: 'https://staging.example.com' }),
    );
  });
});
