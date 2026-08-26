import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const act = TestRenderer.act as (cb: () => unknown) => Promise<void>;
const create = TestRenderer.create as (el: any) => any;

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  Linking: { openURL: () => {} },
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: () => {} }) }));
vi.mock('react-native-markdown-display', () => ({ default: 'Markdown' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({}) }));
vi.mock('../utils/auth', () => ({ hasRole: () => true, getUserRole: () => 'Admin' }));

const apiMock = vi.hoisted(() => ({
  getProjectSkill: vi.fn<(projectId: string, skillId: string) => Promise<any>>(),
  updateProjectSkill: vi.fn<(projectId: string, skillId: string, body: any) => Promise<any>>(),
  getSkillCredentials: vi.fn<(skillId: string) => Promise<any>>(),
  getSkillOptions: vi.fn<(skillId: string, agentId: string) => Promise<any>>(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

const { SkillCard } = await import('./SkillsScreen');

async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function findByTestId(renderer: any, testID: string): any {
  return renderer.root.findAll((node: any) => node.props?.testID === testID, { deep: true })[0];
}

describe('SkillsScreen project-skill authentication setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getProjectSkill.mockResolvedValue({
      content:
        '---\nname: surveytracker-api-data\ndescription: Query live data.\ncategory: integration\n---\n# API',
      credentials: [],
    });
    apiMock.updateProjectSkill.mockResolvedValue({ id: 'surveytracker-api-data' });
    apiMock.getSkillCredentials.mockResolvedValue({ credentials: [] });
    apiMock.getSkillOptions.mockResolvedValue({ options: [] });
  });

  it('adds username/password declarations from the visible authentication action', async () => {
    let renderer!: any;
    await act(async () => {
      renderer = create(
        <SkillCard
          skill={{
            id: 'surveytracker-api-data',
            name: 'Survey Tracker API',
            description: 'Query live data.',
            category: 'integration',
            source: 'project',
            credentials: [],
          }}
          agentId="agent-1"
          projectId="survey-tracker-user"
          overrides={[]}
          isInstalled
          canManageCredentials
        />,
      );
    });

    await act(async () => {
      findByTestId(renderer, 'skill-auth-toggle-surveytracker-api-data').props.onPress({
        stopPropagation: () => {},
      });
      await flushMicrotasks();
    });
    expect(findByTestId(renderer, 'skill-auth-setup-surveytracker-api-data')).toBeTruthy();

    await act(async () => {
      findByTestId(renderer, 'skill-auth-username-password-surveytracker-api-data').props.onPress();
      await flushMicrotasks();
    });

    expect(apiMock.updateProjectSkill).toHaveBeenCalledWith(
      'survey-tracker-user',
      'surveytracker-api-data',
      expect.objectContaining({
        expectedCredentials: [],
        credentials: [
          expect.objectContaining({ name: 'SURVEYTRACKER_API_DATA_USERNAME', type: 'string' }),
          expect.objectContaining({ name: 'SURVEYTRACKER_API_DATA_PASSWORD', type: 'secret' }),
        ],
      }),
    );
    expect(JSON.stringify(renderer.toJSON())).toContain('Credentials');
    expect(JSON.stringify(renderer.toJSON())).toContain('Username');
    expect(JSON.stringify(renderer.toJSON())).toContain('Password');
  });

  it('keeps authentication added after the card loaded instead of replacing it', async () => {
    const content =
      '---\nname: surveytracker-api-data\ndescription: Query live data.\ncategory: integration\n---\n# API';
    apiMock.getProjectSkill
      .mockResolvedValueOnce({ content, credentials: [] })
      .mockResolvedValueOnce({
        content,
        credentials: [
          {
            name: 'SURVEYTRACKER_SESSION_TOKEN',
            label: 'Session token',
            type: 'secret',
            required: true,
          },
        ],
      });

    let renderer!: any;
    await act(async () => {
      renderer = create(
        <SkillCard
          skill={{
            id: 'surveytracker-api-data',
            name: 'Survey Tracker API',
            description: 'Query live data.',
            category: 'integration',
            source: 'project',
            credentials: [],
          }}
          agentId="agent-1"
          projectId="survey-tracker-user"
          overrides={[]}
          isInstalled
          canManageCredentials
        />,
      );
    });

    await act(async () => {
      findByTestId(renderer, 'skill-auth-toggle-surveytracker-api-data').props.onPress({
        stopPropagation: () => {},
      });
      await flushMicrotasks();
    });
    await act(async () => {
      findByTestId(renderer, 'skill-auth-api-key-surveytracker-api-data').props.onPress();
      await flushMicrotasks();
    });

    expect(apiMock.updateProjectSkill).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain('Session token');
  });
});
