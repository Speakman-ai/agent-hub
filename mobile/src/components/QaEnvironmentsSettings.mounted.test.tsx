/**
 * Mobile QA settings: an untouched saved password is not sent on save, so the
 * server keeps it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

const env = {
  id: 'env-1',
  projectId: 'p1',
  name: 'Staging',
  baseUrl: 'https://staging.example.com',
  notes: '',
  position: 0,
  createdAt: '',
  updatedAt: '',
  accounts: [
    {
      id: 'acc_1',
      label: 'Admin',
      username: 'a@x.com',
      password: '••••••••',
      hasPassword: true,
      notes: '',
    },
  ],
};
const updateQaEnvironment = vi.fn(async () => ({ environment: env }));
vi.mock('../utils/api', () => ({
  api: {
    listQaEnvironments: vi.fn(async () => ({ environments: [env] })),
    updateQaEnvironment: (...a: unknown[]) => (updateQaEnvironment as any)(...a),
  },
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: QaEnvironmentsSettings } = await import('./QaEnvironmentsSettings');
process.env.NODE_ENV = originalNodeEnv;

describe('mobile QaEnvironmentsSettings', () => {
  it('saves edits without resending the saved password', async () => {
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<QaEnvironmentsSettings projectId="p1" />);
    });
    const notes = tree.root.find(
      (n: any) => n.type === 'TextInput' && /Build or version/.test(n.props.placeholder ?? ''),
    );
    await act(async () => notes.props.onChangeText('v2.5'));
    const save = tree.root.find((n: any) => n.props?.testID === 'qa-env-save');
    await act(async () => save.props.onPress());
    expect(updateQaEnvironment).toHaveBeenCalledTimes(1);
    const [, id, input] = updateQaEnvironment.mock.calls[0] as unknown[] as [
      string,
      string,
      { notes: string; accounts: Array<Record<string, unknown>> },
    ];
    expect(id).toBe('env-1');
    expect(input.notes).toBe('v2.5');
    expect(input.accounts[0]).not.toHaveProperty('password');
  });

  it('locks edits while a save is in flight so none are dropped', async () => {
    let resolve!: (v: unknown) => void;
    updateQaEnvironment.mockImplementationOnce(() => new Promise((r) => (resolve = r)) as never);
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<QaEnvironmentsSettings projectId="p1" />);
    });
    const notes = () =>
      tree.root.find(
        (n: any) => n.type === 'TextInput' && /Build or version/.test(n.props.placeholder ?? ''),
      );
    await act(async () => notes().props.onChangeText('v2.5'));
    const save = tree.root.find((n: any) => n.props?.testID === 'qa-env-save');
    await act(async () => {
      save.props.onPress();
    });
    expect(notes().props.editable).toBe(false);
    await act(async () => notes().props.onChangeText('typed during save'));
    expect(notes().props.value).toBe('v2.5');
    await act(async () => resolve({ environment: { ...env, notes: 'v2.5' } }));
    expect(notes().props.editable).toBe(true);
    expect(notes().props.value).toBe('v2.5');
  });
});
