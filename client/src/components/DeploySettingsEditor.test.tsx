import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeploySettingsEditor from './DeploySettingsEditor';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getDeploySettings: vi.fn(),
    saveDeploySettings: vi.fn(),
    revertDeploySettings: vi.fn(),
  },
}));

const REPO = {
  projectId: 'p1',
  source: 'repo',
  updatedAt: null,
  updatedBy: null,
  repoError: null,
  preview: null,
  environments: {
    production: {
      approval: true,
      'runs-on': 'ubuntu-24.04',
      timeout_minutes: 30,
      steps: [{ name: 'deploy', run: './deploy.sh' }],
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).confirm = vi.fn(() => true);
});

describe('DeploySettingsEditor', () => {
  it('edits a deploy.yaml environment and saves it as settings', async () => {
    (api.getDeploySettings as any).mockResolvedValue(REPO);
    (api.saveDeploySettings as any).mockImplementation(
      async (_p: string, environments: any, preview: any) => ({
        ...REPO,
        source: 'settings',
        environments,
        preview,
      }),
    );
    const onSaved = vi.fn();
    render(<DeploySettingsEditor projectId="p1" canEdit onSaved={onSaved} />);

    await waitFor(() => expect(screen.getByDisplayValue('production')).toBeTruthy());
    expect(screen.getByTestId('deploy-settings-source').textContent).toContain('deploy.yaml');

    fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '45' } });
    fireEvent.change(screen.getByDisplayValue('./deploy.sh'), {
      target: { value: './deploy-v2.sh' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(api.saveDeploySettings).toHaveBeenCalled());
    expect((api.saveDeploySettings as any).mock.calls[0]).toEqual([
      'p1',
      {
        production: {
          approval: true,
          'runs-on': 'ubuntu-24.04',
          timeout_minutes: 45,
          steps: [{ name: 'deploy', run: './deploy-v2.sh' }],
        },
      },
      null,
    ]);
    await waitFor(() =>
      expect(screen.getByTestId('deploy-settings-source').textContent).toBe('Saved in settings'),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('blocks save and lists problems for an incomplete environment', async () => {
    (api.getDeploySettings as any).mockResolvedValue({ ...REPO, source: 'none', environments: {} });
    render(<DeploySettingsEditor projectId="p1" canEdit />);
    await waitFor(() => expect(screen.getByText('Add environment')).toBeTruthy());
    fireEvent.click(screen.getByText('Add environment'));
    fireEvent.click(screen.getByText('Save'));
    expect(screen.getByTestId('deploy-settings-errors').textContent).toContain(
      'command is required',
    );
    expect(api.saveDeploySettings).not.toHaveBeenCalled();
  });

  it('is read-only without Admin', async () => {
    (api.getDeploySettings as any).mockResolvedValue(REPO);
    render(<DeploySettingsEditor projectId="p1" canEdit={false} />);
    await waitFor(() => expect(screen.getByDisplayValue('production')).toBeTruthy());
    expect((screen.getByDisplayValue('production') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText('Save')).toBeNull();
  });

  it('never shows or saves a previous project after switching projects', async () => {
    let resolveOld!: (v: any) => void;
    (api.getDeploySettings as any).mockImplementation((projectId: string) =>
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
    (api.saveDeploySettings as any).mockImplementation(
      async (projectId: string, environments: any) => ({
        ...REPO,
        projectId,
        source: 'settings',
        environments,
      }),
    );
    const { rerender } = render(<DeploySettingsEditor projectId="p1" canEdit />);
    rerender(<DeploySettingsEditor projectId="p2" canEdit />);
    await waitFor(() => expect(screen.getByDisplayValue('staging')).toBeTruthy());

    // The slow p1 response lands after p2 loaded: it must be ignored.
    await act(async () => {
      resolveOld(REPO);
    });
    expect(screen.queryByDisplayValue('production')).toBeNull();
    expect(screen.getByDisplayValue('staging')).toBeTruthy();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.saveDeploySettings).toHaveBeenCalled());
    expect((api.saveDeploySettings as any).mock.calls[0][0]).toBe('p2');
    expect(Object.keys((api.saveDeploySettings as any).mock.calls[0][1])).toEqual(['staging']);
  });

  it('keeps writes disabled until the new project has loaded', async () => {
    (api.getDeploySettings as any).mockImplementation((projectId: string) =>
      projectId === 'p1' ? Promise.resolve(REPO) : new Promise(() => {}),
    );
    const { rerender } = render(<DeploySettingsEditor projectId="p1" canEdit />);
    await waitFor(() => expect(screen.getByDisplayValue('production')).toBeTruthy());
    rerender(<DeploySettingsEditor projectId="p2" canEdit />);
    expect(screen.queryByDisplayValue('production')).toBeNull();
    expect(screen.queryByText('Save')).toBeNull();
  });

  it('round-trips a multiline workflow input and the preview block', async () => {
    const preview = { compose: 'compose.yml', service: 'web', port: 3000, health: '/' };
    const environments = {
      prod: {
        approval: false,
        'runs-on': 'ubuntu-24.04',
        timeout_minutes: 60,
        steps: [
          {
            name: 'release',
            github_workflow: {
              workflow: 'r.yml',
              ref: 'main',
              inputs: { notes: 'a\nb', pad: ' x ' },
            },
          },
        ],
      },
    };
    (api.getDeploySettings as any).mockResolvedValue({ ...REPO, environments, preview });
    (api.saveDeploySettings as any).mockImplementation(async (_p: string, e: any, pv: any) => ({
      ...REPO,
      source: 'settings',
      environments: e,
      preview: pv,
    }));
    render(<DeploySettingsEditor projectId="p1" canEdit />);
    await waitFor(() => expect(screen.getByDisplayValue('compose.yml')).toBeTruthy());
    expect(screen.getAllByTestId('workflow-input-row')).toHaveLength(2);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.saveDeploySettings).toHaveBeenCalled());
    const [, savedEnvs, savedPreview] = (api.saveDeploySettings as any).mock.calls[0];
    expect(savedEnvs).toEqual(environments);
    expect(savedPreview).toMatchObject({ compose: 'compose.yml', service: 'web', port: 3000 });
  });
});
