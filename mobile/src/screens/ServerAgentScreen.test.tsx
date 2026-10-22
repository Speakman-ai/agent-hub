/**
 * Server Agent screen + settings, mounted with react-test-renderer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
}));
vi.mock('../components/HubIcon', () => ({ default: () => null }));
vi.mock('./ChatScreen', () => ({ default: () => 'chat-transcript' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ clearHubChat: vi.fn() }) }));

const api = vi.hoisted(() => ({
  getServerAgentSettings: vi.fn(),
  putServerAgentSettings: vi.fn(),
  getServerAgentSkillOptions: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api }));
// The chat account gate's generation stands in for the signed-in account.
const account = vi.hoisted(() => ({ snapshot: { active: true, account: 1 } }));
vi.mock('../hooks/useHubChat', () => ({ useHubChatSnapshot: () => account.snapshot }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { ServerAgentScreen, ServerAgentSettingsScreen } = await import('./ServerAgentScreen');
const { resetServerAgentSettingsForTests } = await import('../utils/serverAgentInstance');
process.env.NODE_ENV = originalNodeEnv;

const settings = (over: Record<string, unknown> = {}) => ({
  name: '',
  instructions: '',
  defaultName: 'Server Agent',
  effectiveName: 'Server Agent',
  ...over,
});
const flush = () => act(async () => {});
const byId = (r: any, id: string) => r.root.find((n: any) => n.props?.testID === id);
const text = (node: any) => {
  const out: string[] = [];
  const walk = (n: any) => {
    if (typeof n === 'string') out.push(n);
    else n?.children?.forEach(walk);
  };
  walk(node);
  return out.join('');
};

beforeEach(() => {
  vi.clearAllMocks();
  account.snapshot = { active: true, account: 1 };
  resetServerAgentSettingsForTests();
  api.getServerAgentSkillOptions.mockResolvedValue({
    builtIn: ['agent-hub'],
    global: [{ id: 'github', name: 'github', description: 'GitHub', source: 'default' }],
    projects: [
      {
        projectId: 'p1',
        projectName: 'Payments',
        skills: [{ id: 'deploy', name: 'deploy', description: 'Ship it', source: 'project' }],
      },
    ],
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('ServerAgentScreen', () => {
  it('shows the agent name over the Hub chat and opens settings', async () => {
    api.getServerAgentSettings.mockResolvedValue(settings({ name: 'Jarvis' }));
    const onOpenSettings = vi.fn();
    let r: any;
    await act(async () => {
      r = TestRenderer.create(React.createElement(ServerAgentScreen, { onOpenSettings }));
    });
    await flush();
    expect(text(byId(r, 'server-agent-name'))).toBe('Jarvis');
    expect(JSON.stringify(r.toJSON())).toContain('chat-transcript');
    act(() => byId(r, 'server-agent-open-settings').props.onPress());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('ServerAgentSettingsScreen', () => {
  it('saves name and instructions', async () => {
    api.getServerAgentSettings.mockResolvedValue(settings({ instructions: 'Be brief.' }));
    api.putServerAgentSettings.mockImplementation(async (body: Record<string, string>) =>
      settings(body),
    );
    let r: any;
    await act(async () => {
      r = TestRenderer.create(
        React.createElement(ServerAgentSettingsScreen, { onBack: () => undefined }),
      );
    });
    await flush();
    expect(byId(r, 'server-agent-settings-instructions').props.value).toBe('Be brief.');
    expect(byId(r, 'server-agent-settings-save').props.disabled).toBe(true);

    act(() => byId(r, 'server-agent-settings-name').props.onChangeText('Jarvis'));
    expect(byId(r, 'server-agent-settings-save').props.disabled).toBe(false);
    await act(async () => byId(r, 'server-agent-settings-save').props.onPress());
    await flush();

    expect(api.putServerAgentSettings).toHaveBeenCalledWith({
      name: 'Jarvis',
      instructions: 'Be brief.',
    });
    expect(text(byId(r, 'server-agent-settings-status'))).toContain('Saved');
  });
});

describe('ServerAgentSettingsScreen across an account switch', () => {
  const el = () => React.createElement(ServerAgentSettingsScreen, { onBack: () => undefined });

  it("drops A's edited draft and saves only B's values for B", async () => {
    const forB = deferred<ReturnType<typeof settings>>();
    api.getServerAgentSettings
      .mockResolvedValueOnce(settings({ name: 'A-agent', instructions: 'A secret' }))
      .mockReturnValueOnce(forB.promise);
    api.putServerAgentSettings.mockImplementation(async (body: Record<string, string>) =>
      settings(body),
    );
    let r: any;
    await act(async () => {
      r = TestRenderer.create(el());
    });
    await flush();
    expect(byId(r, 'server-agent-settings-instructions').props.value).toBe('A secret');
    act(() => byId(r, 'server-agent-settings-name').props.onChangeText('A edited'));

    // An org switch: no account for a moment, then B while its fetch is pending.
    account.snapshot = { active: false, account: 2 };
    await act(async () => r.update(el()));
    account.snapshot = { active: true, account: 3 };
    await act(async () => r.update(el()));
    expect(byId(r, 'server-agent-settings-name').props.value).toBe('');
    expect(byId(r, 'server-agent-settings-instructions').props.value).toBe('');
    expect(byId(r, 'server-agent-settings-save').props.disabled).toBe(true);

    await act(async () => forB.resolve(settings({ name: 'B-agent', instructions: 'B notes' })));
    await flush();
    expect(byId(r, 'server-agent-settings-name').props.value).toBe('B-agent');
    act(() => byId(r, 'server-agent-settings-name').props.onChangeText('B2'));
    await act(async () => byId(r, 'server-agent-settings-save').props.onPress());
    await flush();
    expect(api.putServerAgentSettings).toHaveBeenCalledTimes(1);
    expect(api.putServerAgentSettings).toHaveBeenCalledWith({
      name: 'B2',
      instructions: 'B notes',
    });
  });

  it("ignores A's request that lands after switching to B", async () => {
    const forA = deferred<ReturnType<typeof settings>>();
    api.getServerAgentSettings
      .mockReturnValueOnce(forA.promise)
      .mockResolvedValueOnce(settings({ name: 'B-agent', instructions: 'B notes' }));
    let r: any;
    await act(async () => {
      r = TestRenderer.create(el());
    });
    account.snapshot = { active: true, account: 3 };
    await act(async () => r.update(el()));
    await flush();
    await act(async () => forA.resolve(settings({ name: 'A-agent', instructions: 'A secret' })));
    await flush();
    expect(byId(r, 'server-agent-settings-name').props.value).toBe('B-agent');
    expect(byId(r, 'server-agent-settings-instructions').props.value).toBe('B notes');
  });

  it("ignores A's save that completes after switching to B", async () => {
    const savingA = deferred<ReturnType<typeof settings>>();
    api.getServerAgentSettings
      .mockResolvedValueOnce(settings({ name: 'A-agent', instructions: 'A secret' }))
      .mockResolvedValueOnce(settings({ name: 'B-agent', instructions: 'B notes' }));
    api.putServerAgentSettings
      .mockReturnValueOnce(savingA.promise)
      .mockImplementation(async (body: Record<string, string>) => settings(body));
    let r: any;
    await act(async () => {
      r = TestRenderer.create(el());
    });
    await flush();
    act(() => byId(r, 'server-agent-settings-name').props.onChangeText('A2'));
    let pendingSave: Promise<void> | undefined;
    act(() => {
      pendingSave = byId(r, 'server-agent-settings-save').props.onPress();
    });
    expect(api.putServerAgentSettings).toHaveBeenCalledTimes(1);

    account.snapshot = { active: true, account: 3 };
    await act(async () => r.update(el()));
    await flush();
    expect(byId(r, 'server-agent-settings-instructions').props.value).toBe('B notes');

    await act(async () => {
      savingA.resolve(settings({ name: 'A2', instructions: 'A secret' }));
      await pendingSave;
    });
    expect(byId(r, 'server-agent-settings-name').props.value).toBe('B-agent');
    expect(byId(r, 'server-agent-settings-instructions').props.value).toBe('B notes');
    expect(
      r.root.findAll((n: any) => n.props?.testID === 'server-agent-settings-status'),
    ).toHaveLength(0);

    act(() => byId(r, 'server-agent-settings-name').props.onChangeText('B2'));
    await act(async () => byId(r, 'server-agent-settings-save').props.onPress());
    expect(api.putServerAgentSettings).toHaveBeenCalledTimes(2);
    expect(api.putServerAgentSettings).toHaveBeenLastCalledWith({
      name: 'B2',
      instructions: 'B notes',
    });
  });
});

describe('ServerAgentSettingsScreen while a save is pending', () => {
  it('keeps edits typed after pressing Save', async () => {
    const saving = deferred<ReturnType<typeof settings>>();
    api.getServerAgentSettings.mockResolvedValue(settings({ name: 'A', instructions: 'one' }));
    api.putServerAgentSettings.mockReturnValueOnce(saving.promise);
    let r: any;
    await act(async () => {
      r = TestRenderer.create(
        React.createElement(ServerAgentSettingsScreen, { onBack: () => undefined }),
      );
    });
    await flush();
    act(() => byId(r, 'server-agent-settings-name').props.onChangeText('Jarvis'));
    let pendingSave: Promise<void> | undefined;
    act(() => {
      pendingSave = byId(r, 'server-agent-settings-save').props.onPress();
    });
    expect(api.putServerAgentSettings).toHaveBeenCalledWith({
      name: 'Jarvis',
      instructions: 'one',
    });
    expect(byId(r, 'server-agent-settings-save').props.disabled).toBe(true);

    act(() => byId(r, 'server-agent-settings-name').props.onChangeText('Friday'));
    act(() => byId(r, 'server-agent-settings-instructions').props.onChangeText('two'));

    await act(async () => {
      saving.resolve(settings({ name: 'Jarvis', instructions: 'one' }));
      await pendingSave;
    });
    expect(byId(r, 'server-agent-settings-name').props.value).toBe('Friday');
    expect(byId(r, 'server-agent-settings-instructions').props.value).toBe('two');
    expect(text(byId(r, 'server-agent-settings-status'))).toContain('Saved');
    expect(byId(r, 'server-agent-settings-save').props.disabled).toBe(false);
  });
});

describe('ServerAgentSettingsScreen when loading fails', () => {
  it('shows the error with Retry, and loads the form when the retry succeeds', async () => {
    api.getServerAgentSettings
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValueOnce(settings({ name: 'Jarvis', instructions: 'Be brief.' }));
    let r: any;
    await act(async () => {
      r = TestRenderer.create(
        React.createElement(ServerAgentSettingsScreen, { onBack: () => undefined }),
      );
    });
    await flush();
    expect(text(byId(r, 'server-agent-settings-load-error'))).toContain('Network down');
    expect(byId(r, 'server-agent-settings-name').props.editable).toBe(false);

    await act(async () => byId(r, 'server-agent-settings-retry').props.onPress());
    await flush();
    expect(byId(r, 'server-agent-settings-name').props.value).toBe('Jarvis');
    expect(byId(r, 'server-agent-settings-name').props.editable).toBe(true);
    expect(
      r.root.findAll((n: any) => n.props?.testID === 'server-agent-settings-load-error'),
    ).toHaveLength(0);
    expect(api.getServerAgentSettings).toHaveBeenCalledTimes(2);
  });
});

describe('ServerAgentSettingsScreen skills', () => {
  it('adds a project skill and removes a global one', async () => {
    api.getServerAgentSettings.mockResolvedValue(settings({ skills: [{ id: 'github' }] }));
    api.putServerAgentSettings.mockImplementation(async (body: Record<string, unknown>) =>
      settings(body),
    );
    let r: any;
    await act(async () => {
      r = TestRenderer.create(
        React.createElement(ServerAgentSettingsScreen, { onBack: () => undefined }),
      );
    });
    await flush();
    expect(text(byId(r, 'server-agent-skill-github'))).toContain('Global');

    act(() => byId(r, 'server-agent-skills-add').props.onPress());
    await act(async () => byId(r, 'server-agent-skills-option-project:p1-deploy').props.onPress());
    await flush();
    expect(api.putServerAgentSettings).toHaveBeenCalledWith({
      skills: [{ id: 'github' }, { id: 'deploy', projectId: 'p1' }],
    });
    expect(text(byId(r, 'server-agent-skill-deploy'))).toContain('Payments');

    await act(async () => byId(r, 'server-agent-skill-remove-github').props.onPress());
    await flush();
    expect(api.putServerAgentSettings).toHaveBeenLastCalledWith({
      skills: [{ id: 'deploy', projectId: 'p1' }],
    });
  });
});
