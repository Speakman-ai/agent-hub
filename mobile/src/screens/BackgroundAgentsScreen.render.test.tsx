import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';

const state = vi.hoisted(() => ({
  projects: [] as any[],
  refreshProjects: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({ projects: state.projects, refreshProjects: state.refreshProjects }),
}));
vi.mock('../utils/api', () => ({
  api: { updateProject: state.updateProject, runBackgroundAgent: vi.fn() },
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
vi.mock('@shared/utils/humanCron', () => ({ default: () => '' }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: 'ProjectScreenHeader' }));

const React = await import('react');
const { default: TestRenderer, act } = await import('react-test-renderer');
const { default: BackgroundAgentsScreen } = await import('./BackgroundAgentsScreen');

const project = (id: string, schedule: string) => ({
  id,
  name: id,
  backgroundAgents: { wiki: { enabled: true, schedule }, custom: [] },
});

function render(projectId: string) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(BackgroundAgentsScreen, {
        route: { params: { projectId } },
        navigation: { goBack: vi.fn() },
      }),
    );
  });
  return renderer;
}

function rerender(renderer: ReactTestRenderer, projectId: string) {
  act(() => {
    renderer.update(
      React.createElement(BackgroundAgentsScreen, {
        route: { params: { projectId } },
        navigation: { goBack: vi.fn() },
      }),
    );
  });
}

const wikiToggle = (r: ReactTestRenderer) => r.root.findByProps({ testID: 'wiki-agent-enabled' });
const saveButton = (r: ReactTestRenderer) =>
  r.root.findByProps({ testID: 'background-agents-save' });

async function save(r: ReactTestRenderer) {
  await act(async () => {
    await saveButton(r).props.onPress();
  });
}

beforeEach(() => {
  state.projects = [];
  state.refreshProjects.mockReset();
  state.updateProject.mockReset().mockResolvedValue({});
});

describe('BackgroundAgentsScreen', () => {
  it("saves the new project's config after the route switches projects", async () => {
    state.projects = [project('a', '0 1 * * *'), project('b', '0 2 * * *')];
    const renderer = render('a');
    act(() => wikiToggle(renderer).props.onValueChange(false));
    rerender(renderer, 'b');
    expect(wikiToggle(renderer).props.value).toBe(true);
    await save(renderer);
    expect(state.updateProject).toHaveBeenCalledTimes(1);
    const [id, body] = state.updateProject.mock.calls[0];
    expect(id).toBe('b');
    expect(body.backgroundAgents.wiki).toMatchObject({ enabled: true, schedule: '0 2 * * *' });
  });

  it('hydrates the form once the project loads and blocks Save until then', async () => {
    const renderer = render('a');
    expect(saveButton(renderer).props.disabled).toBe(true);
    await save(renderer);
    expect(state.updateProject).not.toHaveBeenCalled();

    state.projects = [project('a', '0 5 * * *')];
    rerender(renderer, 'a');
    expect(saveButton(renderer).props.disabled).toBe(false);
    expect(wikiToggle(renderer).props.value).toBe(true);
    await save(renderer);
    expect(state.updateProject.mock.calls[0][1].backgroundAgents.wiki.schedule).toBe('0 5 * * *');
  });

  it('keeps unsaved edits when the project refreshes, and follows it after a save', async () => {
    state.projects = [project('a', '0 1 * * *')];
    const renderer = render('a');
    act(() => wikiToggle(renderer).props.onValueChange(false));
    state.projects = [project('a', '0 9 * * *')];
    rerender(renderer, 'a');
    expect(wikiToggle(renderer).props.value).toBe(false);

    await save(renderer);
    state.projects = [
      {
        ...project('a', '0 9 * * *'),
        backgroundAgents: { wiki: { enabled: false, schedule: '0 7 * * *' }, custom: [] },
      },
    ];
    rerender(renderer, 'a');
    state.projects = [project('a', '0 8 * * *')];
    rerender(renderer, 'a');
    expect(wikiToggle(renderer).props.value).toBe(true);
  });

  it('keeps an edit made while the save request is in flight', async () => {
    state.projects = [project('a', '0 1 * * *')];
    let resolveSave!: () => void;
    state.updateProject.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveSave = r;
      }),
    );
    const renderer = render('a');
    act(() => wikiToggle(renderer).props.onValueChange(false));
    let saving!: Promise<void>;
    act(() => {
      saving = saveButton(renderer).props.onPress();
    });
    act(() => wikiToggle(renderer).props.onValueChange(true));
    await act(async () => {
      resolveSave();
      await saving;
    });
    // The refresh returns the submitted (older) config.
    state.projects = [
      {
        ...project('a', '0 1 * * *'),
        backgroundAgents: { wiki: { enabled: false, schedule: '0 1 * * *' }, custom: [] },
      },
    ];
    rerender(renderer, 'a');
    expect(wikiToggle(renderer).props.value).toBe(true);
    expect(state.updateProject.mock.calls[0][1].backgroundAgents.wiki.enabled).toBe(false);
  });

  it('locks the form until the project loads, so Save cannot send defaults over it', async () => {
    const renderer = render('a');
    expect(wikiToggle(renderer).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ testID: 'background-agents-add' }).props.disabled).toBe(
      true,
    );
    // Even an edit that gets through before the project arrives is ignored.
    act(() => wikiToggle(renderer).props.onValueChange(true));

    state.projects = [
      {
        id: 'a',
        name: 'a',
        backgroundAgents: {
          wiki: { enabled: false, schedule: '0 2 * * *', ownerUserId: 'u1', model: 'opus' },
          custom: [{ id: 'c1', name: 'Digest', prompt: 'Summarize', enabled: true }],
        },
      },
    ];
    rerender(renderer, 'a');
    expect(wikiToggle(renderer).props.disabled).toBe(false);
    await save(renderer);
    const body = state.updateProject.mock.calls[0][1].backgroundAgents;
    expect(body.wiki).toMatchObject({ enabled: false, ownerUserId: 'u1', model: 'opus' });
    expect(body.custom.map((c: any) => c.id)).toEqual(['c1']);
  });
});
