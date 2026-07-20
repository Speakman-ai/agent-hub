import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/api', () => ({
  api: {
    getProjectAwsProfiles: vi.fn(),
    getProjectAwsSsoStatus: vi.fn(),
    startProjectAwsSsoLogin: vi.fn(),
  },
}));

import { api } from '../utils/api';
import AwsSsoLoginMenu, { extractSsoProfileNames } from './AwsSsoLoginMenu';

const enabledProject = { id: 'proj-1', awsEnabled: true };

function renderMenu(project: any = enabledProject, extra: any = {}) {
  return render(
    <AwsSsoLoginMenu
      projectId={project?.id}
      project={project}
      disabled={extra.disabled ?? false}
      onError={extra.onError ?? vi.fn()}
    />,
  );
}

describe('extractSsoProfileNames', () => {
  it('returns only non-static profiles, sorted', () => {
    const names = extractSsoProfileNames({
      prod: { type: 'sso' },
      keys: { type: 'static' },
      dev: { type: 'sso' },
      legacy: { sso_account_id: '123' }, // no type → treated as SSO
    });
    expect(names).toEqual(['dev', 'legacy', 'prod']);
  });

  it('handles empty / nullish input', () => {
    expect(extractSsoProfileNames(null)).toEqual([]);
    expect(extractSsoProfileNames(undefined)).toEqual([]);
    expect(extractSsoProfileNames({})).toEqual([]);
    expect(extractSsoProfileNames({ only: { type: 'static' } })).toEqual([]);
  });
});

describe('AwsSsoLoginMenu', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (api.getProjectAwsProfiles as any).mockResolvedValue({
      profiles: { dev: { type: 'sso' }, keys: { type: 'static' }, prod: { type: 'sso' } },
    });
    (api.startProjectAwsSsoLogin as any).mockResolvedValue({
      loginUrl: 'https://device.sso.example/verify?user_code=ABCD',
    });
    (api.getProjectAwsSsoStatus as any).mockResolvedValue({
      loggedIn: true,
      account: '123456789012',
    });
    vi.spyOn(window, 'open').mockReturnValue(null as any);
  });

  it('renders nothing when AWS is not enabled', async () => {
    const { container } = renderMenu({ id: 'proj-1', awsEnabled: false });
    await waitFor(() => expect(api.getProjectAwsProfiles).not.toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when there are no SSO profiles', async () => {
    (api.getProjectAwsProfiles as any).mockResolvedValue({
      profiles: { keys: { type: 'static' } },
    });
    const { container } = renderMenu();
    await waitFor(() => expect(api.getProjectAwsProfiles).toHaveBeenCalledWith('proj-1'));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('renders nothing when the profiles fetch fails (e.g. non-admin 403)', async () => {
    (api.getProjectAwsProfiles as any).mockRejectedValue(new Error('403: forbidden'));
    const { container } = renderMenu();
    await waitFor(() => expect(api.getProjectAwsProfiles).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('lists only SSO profiles and walks a profile through login', async () => {
    renderMenu();
    await screen.findByTestId('aws-sso-login-trigger');
    fireEvent.click(screen.getByTestId('aws-sso-login-trigger'));

    // static profile 'keys' must not appear
    expect(screen.getByTestId('aws-sso-login-option-dev')).toBeTruthy();
    expect(screen.getByTestId('aws-sso-login-option-prod')).toBeTruthy();
    expect(screen.queryByTestId('aws-sso-login-option-keys')).toBeNull();

    fireEvent.click(screen.getByTestId('aws-sso-login-option-prod'));
    await waitFor(() => expect(api.startProjectAwsSsoLogin).toHaveBeenCalledWith('proj-1', 'prod'));
    // device URL opened in a new tab + link rendered
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        'https://device.sso.example/verify?user_code=ABCD',
        '_blank',
        'noopener,noreferrer',
      ),
    );
    const link = await screen.findByText('Open SSO link');
    expect(link).toBeTruthy();

    // Check login re-queries status
    fireEvent.click(screen.getByText('Check login'));
    await waitFor(() => expect(api.getProjectAwsSsoStatus).toHaveBeenCalledWith('proj-1', 'prod'));
    await screen.findByText('Logged in: account 123456789012');
  });

  it('closes the open menu and stops login actions when it becomes disabled', async () => {
    const { rerender } = renderMenu();
    await screen.findByTestId('aws-sso-login-trigger');
    fireEvent.click(screen.getByTestId('aws-sso-login-trigger'));
    expect(screen.getByTestId('aws-sso-login-option-prod')).toBeTruthy();

    // Session disconnects: App passes disabled={!connected}.
    rerender(
      <AwsSsoLoginMenu
        projectId={enabledProject.id}
        project={enabledProject}
        disabled={true}
        onError={vi.fn()}
      />,
    );

    // Menu closes, so the profile option is gone and cannot trigger a login.
    await waitFor(() => expect(screen.queryByTestId('aws-sso-login-option-prod')).toBeNull());
    expect(api.startProjectAwsSsoLogin).not.toHaveBeenCalled();
    // Trigger button is disabled so the menu cannot be reopened.
    expect((screen.getByTestId('aws-sso-login-trigger') as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears stale per-profile login state when projectId changes', async () => {
    const { rerender } = renderMenu();
    await screen.findByTestId('aws-sso-login-trigger');
    fireEvent.click(screen.getByTestId('aws-sso-login-trigger'));
    fireEvent.click(screen.getByTestId('aws-sso-login-option-prod'));
    await screen.findByText('Open SSO link');

    // Switch active project: same-named 'prod' profile exists in the new one.
    (api.getProjectAwsProfiles as any).mockResolvedValue({ profiles: { prod: { type: 'sso' } } });
    rerender(
      <AwsSsoLoginMenu
        projectId="proj-2"
        project={{ id: 'proj-2', awsEnabled: true }}
        disabled={false}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.getProjectAwsProfiles).toHaveBeenCalledWith('proj-2'));
    // Menu closed and previous project's SSO link did not carry over.
    expect(screen.queryByText('Open SSO link')).toBeNull();
    // Reopen the new project's menu — no stale link is shown.
    fireEvent.click(screen.getByTestId('aws-sso-login-trigger'));
    expect(screen.getByTestId('aws-sso-login-option-prod')).toBeTruthy();
    expect(screen.queryByText('Open SSO link')).toBeNull();
  });

  it('surfaces a login error via onError', async () => {
    (api.startProjectAwsSsoLogin as any).mockRejectedValue(new Error('boom'));
    const onError = vi.fn();
    renderMenu(enabledProject, { onError });
    await screen.findByTestId('aws-sso-login-trigger');
    fireEvent.click(screen.getByTestId('aws-sso-login-trigger'));
    fireEvent.click(screen.getByTestId('aws-sso-login-option-dev'));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('boom'));
  });
});
