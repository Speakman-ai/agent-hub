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
vi.mock('lucide-react-native', () => ({ X: 'X' }));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
vi.mock('../utils/api', () => ({ api: {} }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const TestRenderer = (await import('react-test-renderer')).default;
const { default: MobileRoutineDialog } = await import('./MobileRoutineDialog');
process.env.NODE_ENV = originalNodeEnv;
const { act, create } = TestRenderer;

function byId(root: any, testID: string) {
  return root.findAll((n: any) => n.props?.testID === testID && typeof n.type === 'string')[0];
}

describe('MobileRoutineDialog', () => {
  it('drafts, saves the edited skill and schedules it as a routine', async () => {
    const client = {
      draftRoutineFromRecording: vi.fn(async () => ({
        projectId: 'p1',
        agentId: 'ops',
        agentName: 'Ops',
        artifactId: 'art-1',
        steps: 2,
        draft: { name: 'weekly-export', description: 'Export it.', body: '## Steps\n1. Go\n' },
      })),
      createProjectSkill: vi.fn(async () => ({})),
      createCron: vi.fn(async () => ({})),
    };
    let renderer: any;
    act(() => {
      renderer = create(
        <MobileRoutineDialog sessionId="s1" artifactId="art-1" onClose={vi.fn()} client={client} />,
      );
    });
    const root = renderer.root;

    await act(async () => byId(root, 'mobile-routine-draft').props.onPress());
    expect(client.draftRoutineFromRecording).toHaveBeenCalledWith('s1', { artifactId: 'art-1' });

    act(() => byId(root, 'mobile-routine-description').props.onChangeText('Export the report.'));
    await act(async () => byId(root, 'mobile-routine-save').props.onPress());
    expect(client.createProjectSkill).toHaveBeenCalledWith('p1', {
      name: 'weekly-export',
      description: 'Export the report.',
      category: 'general',
      body: '## Steps\n1. Go\n',
    });

    act(() => byId(root, 'mobile-routine-preset-daily-9').props.onPress());
    await act(async () => byId(root, 'mobile-routine-schedule').props.onPress());
    expect(client.createCron).toHaveBeenCalledWith(
      expect.objectContaining({
        routine_skill: 'weekly-export',
        skill_principal_agent_id: 'ops',
        project_id: 'p1',
        schedule: '0 9 * * *',
      }),
    );
    expect(byId(root, 'mobile-routine-done')).toBeTruthy();
  });

  it('shows the draft error and stays on the first step', async () => {
    const client = {
      draftRoutineFromRecording: vi.fn(async () => {
        throw new Error('Drafting failed: Timed out');
      }),
      createProjectSkill: vi.fn(),
      createCron: vi.fn(),
    };
    let renderer: any;
    act(() => {
      renderer = create(
        <MobileRoutineDialog sessionId="s1" artifactId="art-1" onClose={vi.fn()} client={client} />,
      );
    });
    await act(async () => byId(renderer.root, 'mobile-routine-draft').props.onPress());
    expect(JSON.stringify(renderer.toJSON())).toContain('Drafting failed: Timed out');
    expect(byId(renderer.root, 'mobile-routine-goal')).toBeTruthy();
  });
});
