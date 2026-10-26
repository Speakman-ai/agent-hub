import { describe, expect, it, vi } from 'vitest';
import type { ReactTestRenderer, TestRendererOptions } from 'react-test-renderer';

// Vitest inherits NODE_ENV=production in Agent Hub's test runner. Load the
// development React renderer explicitly so hooks flush interactively.
process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: any) => styles },
  Switch: nativeHost('Switch'),
  Text: nativeHost('Text'),
  TextInput: nativeHost('TextInput'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('lucide-react-native', () => ({
  ArrowDown: nativeHost('ArrowDown'),
  ArrowUp: nativeHost('ArrowUp'),
  Plus: nativeHost('Plus'),
  RotateCcw: nativeHost('RotateCcw'),
  Save: nativeHost('Save'),
  Trash2: nativeHost('Trash2'),
}));

const api = {
  getDeploySettings: vi.fn(),
  saveDeploySettings: vi.fn(),
  revertDeploySettings: vi.fn(),
};
vi.mock('../../utils/api', () => ({ api }));

const { default: DeploySettingsEditor } = await import('./DeploySettingsEditor');

const rendererOptions: TestRendererOptions = { createNodeMock: () => ({}) };

const REPO = {
  projectId: 'p1',
  source: 'repo',
  updatedAt: null,
  updatedBy: null,
  repoError: null,
  preview: null,
  environments: {
    production: { approval: true, steps: [{ name: 'deploy', run: './deploy.sh' }] },
  },
};

async function flush() {
  await TestRenderer.act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('mobile DeploySettingsEditor', () => {
  it('loads, edits, and saves environments', async () => {
    api.getDeploySettings.mockResolvedValue(REPO);
    api.saveDeploySettings.mockImplementation(async (_p: string, environments: any) => ({
      ...REPO,
      source: 'settings',
      environments,
    }));
    let renderer!: ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        <DeploySettingsEditor projectId="p1" canEdit />,
        rendererOptions,
      );
    });
    await flush();

    const command = renderer.root.findByProps({
      accessibilityLabel: 'Command (bash -euo pipefail)',
    });
    expect(command.props.value).toBe('./deploy.sh');
    TestRenderer.act(() => command.props.onChangeText('./ship.sh'));

    const save = renderer.root.findByProps({ accessibilityLabel: 'Save deployment settings' });
    await TestRenderer.act(async () => {
      await save.props.onPress();
    });
    expect(api.saveDeploySettings).toHaveBeenCalledWith(
      'p1',
      {
        production: {
          approval: true,
          'runs-on': 'ubuntu-24.04',
          timeout_minutes: 60,
          steps: [{ name: 'deploy', run: './ship.sh' }],
        },
      },
      null,
    );
    expect(renderer.root.findByProps({ testID: 'deploy-settings-source' }).props.children).toBe(
      'Saved in settings',
    );
  });

  it('hides save controls without Admin', async () => {
    api.getDeploySettings.mockResolvedValue(REPO);
    let renderer!: ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        <DeploySettingsEditor projectId="p1" canEdit={false} />,
        rendererOptions,
      );
    });
    await flush();
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Save deployment settings' }),
    ).toHaveLength(0);
    const name = renderer.root.findByProps({ accessibilityLabel: 'Environment name' });
    expect(name.props.editable).toBe(false);
  });

  it('ignores a slow response from the previous project and saves to the current one', async () => {
    let resolveOld!: (v: any) => void;
    api.getDeploySettings.mockImplementation((projectId: string) =>
      projectId === 'p1'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({
            ...REPO,
            projectId: 'p2',
            environments: { staging: { steps: [{ name: 's', run: './s.sh' }] } },
          }),
    );
    api.saveDeploySettings.mockReset();
    api.saveDeploySettings.mockImplementation(async (projectId: string, environments: any) => ({
      ...REPO,
      projectId,
      source: 'settings',
      environments,
    }));
    let renderer!: ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        <DeploySettingsEditor projectId="p1" canEdit />,
        rendererOptions,
      );
    });
    TestRenderer.act(() => {
      renderer.update(<DeploySettingsEditor projectId="p2" canEdit />);
    });
    await flush();
    await TestRenderer.act(async () => {
      resolveOld(REPO);
    });
    const name = renderer.root.findByProps({ accessibilityLabel: 'Environment name' });
    expect(name.props.value).toBe('staging');

    const save = renderer.root.findByProps({ accessibilityLabel: 'Save deployment settings' });
    await TestRenderer.act(async () => {
      await save.props.onPress();
    });
    expect(api.saveDeploySettings.mock.calls[0][0]).toBe('p2');
    expect(Object.keys(api.saveDeploySettings.mock.calls[0][1])).toEqual(['staging']);
  });
});
