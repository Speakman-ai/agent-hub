// @vitest-environment jsdom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  updateProject: vi.fn(() => Promise.resolve({})),
  deleteProject: vi.fn(() => Promise.resolve({})),
}));

function host(tag: string) {
  return ({ children, testID, onPress, style }: any) =>
    React.createElement(
      tag,
      { 'data-testid': testID, onClick: onPress, style: Array.isArray(style) ? undefined : style },
      children,
    );
}

function SwitchMock({ testID, value, onValueChange, disabled }: any) {
  return React.createElement('input', {
    type: 'checkbox',
    'data-testid': testID,
    checked: !!value,
    disabled: disabled || undefined,
    onChange: (e: any) => onValueChange?.(e.target.checked),
  });
}

vi.mock('react-native', () => ({
  View: host('div'),
  Text: host('span'),
  ScrollView: host('div'),
  TouchableOpacity: host('button'),
  ActivityIndicator: host('span'),
  Switch: SwitchMock,
  TextInput: ({ testID, value, onChangeText }: any) =>
    React.createElement('input', {
      'data-testid': testID,
      value,
      onInput: (event: any) => onChangeText?.(event.target.value),
      readOnly: true,
    }),
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: any) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: host('main') }));
vi.mock('../components/OrganizationsPanel', () => ({
  default: ({ projectId }: any) => <div data-testid={`project-organizations-${projectId}`} />,
}));
vi.mock('../utils/api', () => ({ api: apiMocks }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: () => null }));
vi.mock('../components/settings/ProjectDefaultAutomationSection', () => ({ default: () => null }));
vi.mock('../components/settings/ProjectEmailLogoSection', () => ({ default: () => null }));

const appState: any = { projects: [], refreshProjects: vi.fn(() => Promise.resolve()) };
vi.mock('../context/AppContext', () => ({ useApp: () => appState }));

import ProjectSettingsScreen from './ProjectSettingsScreen';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 8; j += 1) await Promise.resolve();
    flushSync(() => undefined);
  }
}

describe('ProjectSettingsScreen — feature request approval toggle', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('defaults off and persists voting.enabled via updateProject', async () => {
    const project = { id: 'p1', name: 'Acme', color: '#6366f1', githubRepo: '' };
    const { container, root } = mount();
    flushSync(() =>
      root.render(
        <ProjectSettingsScreen route={{ params: { projectId: 'p1', project } }} navigation={{}} />,
      ),
    );
    await flush();

    const toggle = container.querySelector(
      '[data-testid="project-voting-enabled-p1"]',
    ) as HTMLInputElement;
    expect(container.querySelector('[data-testid="project-organizations-p1"]')).toBeTruthy();
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(false);

    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(apiMocks.updateProject).toHaveBeenCalledWith('p1', { voting: { enabled: true } });
    flushSync(() => root.unmount());
  });
});

describe('ProjectSettingsScreen project icon', () => {
  it('saves complete emoji and clears it back to color', async () => {
    const project = { id: 'p1', name: 'Acme', icon: '★', color: '#6366f1' };
    const { container, root } = mount();
    flushSync(() =>
      root.render(
        <ProjectSettingsScreen route={{ params: { projectId: 'p1', project } }} navigation={{}} />,
      ),
    );
    await flush();
    const input = container.querySelector('[data-testid="project-icon-input"]') as HTMLInputElement;
    expect(input.value).toBe('★');
    input.value = '👩🏽‍💻';
    flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })));
    (container.querySelector('[data-testid="save-project-icon"]') as HTMLButtonElement).click();
    await flush();
    expect(apiMocks.updateProject).toHaveBeenLastCalledWith('p1', { icon: '👩🏽‍💻' });
    (container.querySelector('[data-testid="clear-project-icon"]') as HTMLButtonElement).click();
    await flush();
    expect(apiMocks.updateProject).toHaveBeenLastCalledWith('p1', { icon: null });
    expect(appState.refreshProjects).toHaveBeenCalled();
    expect(input.value).toBe('');
    flushSync(() => root.unmount());
    container.remove();
  });
});
