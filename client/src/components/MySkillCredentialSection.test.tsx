import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSkillCredentials: vi.fn(),
    putSkillCredential: vi.fn(),
  },
}));

(vi as any).mock('../utils/api.js', () => ({
  api: apiMock,
}));

import MySkillCredentialSection from './MySkillCredentialSection';

function emptyCredentials() {
  return { credentials: [] };
}

function maskedRow(overrides: any = {}) {
  return {
    id: 'cred-1',
    skill_id: 'linear',
    key_name: 'LINEAR_API_KEY',
    masked_preview: '••••a1b2',
    last_used_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  (apiMock.getSkillCredentials as any).mockReset();
  (apiMock.putSkillCredential as any).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MySkillCredentialSection — load + render', () => {
  it('renders "Not set" badge when no row exists', async () => {
    (apiMock.getSkillCredentials as any).mockResolvedValue(emptyCredentials());

    render(
      <MySkillCredentialSection
        skillId="linear"
        keyName="LINEAR_API_KEY"
        label="Linear API key"
        placeholder="lin_api_..."
      />,
    );

    expect(await screen.findByText(/not set/i)).toBeInTheDocument();
    expect(apiMock.getSkillCredentials).toHaveBeenCalledWith('linear');
  });

  it('renders masked preview + "Set" badge when a row exists for the key', async () => {
    (apiMock.getSkillCredentials as any).mockResolvedValue({ credentials: [maskedRow()] });

    render(
      <MySkillCredentialSection
        skillId="linear"
        keyName="LINEAR_API_KEY"
        label="Linear API key"
        placeholder="lin_api_..."
      />,
    );

    expect(await screen.findByText('••••a1b2')).toBeInTheDocument();
    expect(screen.getByText(/^set$/i)).toBeInTheDocument();
  });

  it('ignores credentials rows for OTHER key names within the same skill', async () => {
    (apiMock.getSkillCredentials as any).mockResolvedValue({
      credentials: [maskedRow({ key_name: 'SOME_OTHER_KEY', masked_preview: '••••zzzz' })],
    });

    render(
      <MySkillCredentialSection skillId="linear" keyName="LINEAR_API_KEY" label="Linear API key" />,
    );

    expect(await screen.findByText(/not set/i)).toBeInTheDocument();
    expect(screen.queryByText('••••zzzz')).toBeNull();
  });

  it('degrades gracefully on 401 (legacy global apiKey path)', async () => {
    (apiMock.getSkillCredentials as any).mockRejectedValue(
      new Error('401: Authentication required'),
    );

    render(
      <MySkillCredentialSection skillId="linear" keyName="LINEAR_API_KEY" label="Linear API key" />,
    );

    expect(await screen.findByText(/sign in as a user/i)).toBeInTheDocument();
  });
});

describe('MySkillCredentialSection — save / clear', () => {
  it('PUTs { skill_id, key_name, value } without agent_id on save', async () => {
    apiMock.getSkillCredentials
      .mockResolvedValueOnce(emptyCredentials())
      .mockResolvedValueOnce({ credentials: [maskedRow()] });
    (apiMock.putSkillCredential as any).mockResolvedValue({ credential: maskedRow() });

    render(
      <MySkillCredentialSection
        skillId="linear"
        keyName="LINEAR_API_KEY"
        label="Linear API key"
        placeholder="lin_api_..."
      />,
    );

    const input = await screen.findByPlaceholderText('lin_api_...');
    fireEvent.change(input, { target: { value: '  lin_api_pasted_value  ' } } as any);
    fireEvent.click(screen.getByRole('button', { name: /save linear api key/i } as any) as any);

    await waitFor(() => expect(apiMock.putSkillCredential).toHaveBeenCalledTimes(1));
    expect(apiMock.putSkillCredential).toHaveBeenCalledWith({
      skill_id: 'linear',
      key_name: 'LINEAR_API_KEY',
      value: 'lin_api_pasted_value',
    });
    // No agent_id in the body — the Account page flow is workspace-free.
    expect((apiMock.putSkillCredential as any).mock.calls[0][0]).not.toHaveProperty('agent_id');
  });

  it('Clear button PUTs value: "" to clear the row', async () => {
    apiMock.getSkillCredentials
      .mockResolvedValueOnce({ credentials: [maskedRow()] })
      .mockResolvedValueOnce(emptyCredentials());
    (apiMock.putSkillCredential as any).mockResolvedValue({ credential: null, cleared: true });

    render(
      <MySkillCredentialSection skillId="linear" keyName="LINEAR_API_KEY" label="Linear API key" />,
    );

    const clearBtn = await screen.findByRole('button', { name: /clear my linear api key/i });
    fireEvent.click(clearBtn as any);

    await waitFor(() => expect(apiMock.putSkillCredential).toHaveBeenCalledTimes(1));
    expect(apiMock.putSkillCredential).toHaveBeenCalledWith({
      skill_id: 'linear',
      key_name: 'LINEAR_API_KEY',
      value: '',
    });
  });

  it('shows error message in an alert when PUT rejects', async () => {
    (apiMock.getSkillCredentials as any).mockResolvedValue(emptyCredentials());
    (apiMock.putSkillCredential as any).mockRejectedValue(new Error('500: encryption failed'));

    render(
      <MySkillCredentialSection
        skillId="linear"
        keyName="LINEAR_API_KEY"
        label="Linear API key"
        placeholder="lin_api_..."
      />,
    );

    fireEvent.change(await screen.findByPlaceholderText('lin_api_...' as any), {
      target: { value: 'lin_api_x' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save linear api key/i } as any) as any);

    const alert = await screen.findByRole('alert');
    expect((alert as any).textContent || '').toMatch(/encryption failed/);
  });
});
