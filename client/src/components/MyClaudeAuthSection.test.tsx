import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock the api client before importing the component so we can drive
// every render branch from the test.
(vi as any).mock('../utils/api.js', () => ({
  api: {
    getMyClaudeAuth: vi.fn(),
    putMyClaudeAuth: vi.fn(),
  },
}));

import MyClaudeAuthSection, { StatusChip } from './MyClaudeAuthSection';
import { api } from '../utils/api';

beforeEach(() => {
  (api.getMyClaudeAuth as any).mockReset();
  (api.putMyClaudeAuth as any).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StatusChip', () => {
  it('renders "Using yours" when the user has set their own credential', () => {
    render(<StatusChip kind="api" mine="****abcd" hostFallback={false} />);
    expect(screen.getByText(/using yours/i)).toBeInTheDocument();
  });

  it('renders "Host fallback" when user is empty but host has a value', () => {
    render(<StatusChip kind="api" mine={null} hostFallback={true} />);
    expect(screen.getByText(/host fallback/i)).toBeInTheDocument();
  });

  it('renders "Not configured" when neither user nor host has a value', () => {
    render(<StatusChip kind="api" mine={null} hostFallback={false} />);
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
  });

  it('renders "Yours (expired)" when an OAuth token is past its expiry', () => {
    render(<StatusChip kind="oauth" mine="****abcd" hostFallback={false} expired={true} />);
    expect(screen.getByText(/yours \(expired\)/i)).toBeInTheDocument();
  });
});

describe('MyClaudeAuthSection — load + render', () => {
  it('renders masked credential values and the "Using yours" chip for both slots', async () => {
    (api.getMyClaudeAuth as any).mockResolvedValue({
      anthropicApiKey: '****api-key-tail',
      claudeCodeOAuthToken: '****oauth-tail',
      claudeCodeOAuthExpiresAt: '2099-01-01T00:00:00.000Z',
      claudeCodeOAuthExpired: false,
      updatedAt: '2026-05-01T00:00:00.000Z',
      hostConfigFallback: { anthropicApiKey: true, claudeCodeOAuthToken: false },
    });

    render(<MyClaudeAuthSection />);

    expect(await screen.findByText('****api-key-tail')).toBeInTheDocument();
    expect(screen.getByText('****oauth-tail')).toBeInTheDocument();
    // Both slots have a user-set value → both should show "Using yours".
    expect(screen.getAllByText(/using yours/i)).toHaveLength(2);
  });

  it('shows "Host fallback" when the user field is empty but the host has a value', async () => {
    (api.getMyClaudeAuth as any).mockResolvedValue({
      anthropicApiKey: null,
      claudeCodeOAuthToken: null,
      claudeCodeOAuthExpiresAt: null,
      claudeCodeOAuthExpired: null,
      updatedAt: '2026-05-01T00:00:00.000Z',
      hostConfigFallback: { anthropicApiKey: true, claudeCodeOAuthToken: false },
    });

    render(<MyClaudeAuthSection />);

    expect(await screen.findByText(/host fallback/i)).toBeInTheDocument();
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
  });

  it('shows "Yours (expired)" when an OAuth token is past its expiry', async () => {
    (api.getMyClaudeAuth as any).mockResolvedValue({
      anthropicApiKey: null,
      claudeCodeOAuthToken: '****stale',
      claudeCodeOAuthExpiresAt: '2020-01-01T00:00:00.000Z',
      claudeCodeOAuthExpired: true,
      updatedAt: '2026-05-01T00:00:00.000Z',
      hostConfigFallback: { anthropicApiKey: false, claudeCodeOAuthToken: false },
    });

    render(<MyClaudeAuthSection />);

    expect(await screen.findByText(/yours \(expired\)/i)).toBeInTheDocument();
    expect(screen.getByText('expired')).toBeInTheDocument();
  });

  it('degrades gracefully on 401 (legacy global apiKey, no per-user identity)', async () => {
    (api.getMyClaudeAuth as any).mockRejectedValue(new Error('401: Authentication required'));

    render(<MyClaudeAuthSection />);

    expect(
      await screen.findByText(/sign in as a user .* legacy global API key/i),
    ).toBeInTheDocument();
    // No save buttons, no input fields rendered in this branch.
    expect(screen.queryByLabelText(/anthropic api key/i)).toBeNull();
  });

  it('shows a retry button on non-401 load errors', async () => {
    (api.getMyClaudeAuth as any)
      .mockRejectedValueOnce(new Error('500: boom'))
      .mockResolvedValueOnce({
        anthropicApiKey: null,
        claudeCodeOAuthToken: null,
        claudeCodeOAuthExpiresAt: null,
        claudeCodeOAuthExpired: null,
        updatedAt: null,
        hostConfigFallback: { anthropicApiKey: false, claudeCodeOAuthToken: false },
      });

    render(<MyClaudeAuthSection />);

    const retry = await screen.findByRole('button', { name: /retry/i });
    expect(retry!).toBeInTheDocument();
    fireEvent.click(retry as any);
    await waitFor(() => expect(api.getMyClaudeAuth).toHaveBeenCalledTimes(2));
  });
});

describe('MyClaudeAuthSection — save flows', () => {
  function baseAuth(overrides: any = {}) {
    return {
      anthropicApiKey: null,
      claudeCodeOAuthToken: null,
      claudeCodeOAuthExpiresAt: null,
      claudeCodeOAuthExpired: null,
      updatedAt: '2026-05-01T00:00:00.000Z',
      hostConfigFallback: { anthropicApiKey: false, claudeCodeOAuthToken: false },
      ...overrides,
    };
  }

  it('PUTs only the anthropicApiKey field when saving — other fields stay untouched', async () => {
    (api.getMyClaudeAuth as any).mockResolvedValue(baseAuth());
    (api.putMyClaudeAuth as any).mockResolvedValue(baseAuth({ anthropicApiKey: '****new' }));

    render(<MyClaudeAuthSection />);
    const input = await screen.findByLabelText(/anthropic api key/i);
    fireEvent.change(input, { target: { value: 'sk-ant-api03-abcdefghijklmnop' } } as any);
    fireEvent.click(screen.getByRole('button', { name: /save api key/i } as any) as any);

    await waitFor(() => expect(api.putMyClaudeAuth).toHaveBeenCalledTimes(1));
    // Whitelist: only the field the user touched is sent. The token field is
    // omitted entirely so the server's partial-patch contract leaves it alone.
    expect(api.putMyClaudeAuth).toHaveBeenCalledWith({
      anthropicApiKey: 'sk-ant-api03-abcdefghijklmnop',
    });
  });

  it('Clear button PUTs anthropicApiKey: "" to clear the field', async () => {
    (api.getMyClaudeAuth as any).mockResolvedValue(baseAuth({ anthropicApiKey: '****existing' }));
    (api.putMyClaudeAuth as any).mockResolvedValue(baseAuth());

    render(<MyClaudeAuthSection />);
    const clearBtn = await screen.findByRole('button', { name: /clear my api key/i });
    fireEvent.click(clearBtn as any);

    await waitFor(() => expect(api.putMyClaudeAuth).toHaveBeenCalledTimes(1));
    expect(api.putMyClaudeAuth).toHaveBeenCalledWith({ anthropicApiKey: '' });
  });

  it('collapses whitespace in pasted OAuth tokens before saving', async () => {
    (api.getMyClaudeAuth as any).mockResolvedValue(baseAuth());
    (api.putMyClaudeAuth as any).mockResolvedValue(baseAuth({ claudeCodeOAuthToken: '****abcd' }));

    render(<MyClaudeAuthSection />);
    const input = await screen.findByLabelText(/claude code oauth token/i);
    // Simulate terminal wrap with newlines + spaces inside the token.
    fireEvent.change(input, {
      target: { value: ' sk-ant-oat01-abc\n  def\nghi ' },
    } as any);
    fireEvent.click(screen.getByRole('button', { name: /save oauth token/i } as any) as any);

    await waitFor(() => expect(api.putMyClaudeAuth).toHaveBeenCalledTimes(1));
    expect(api.putMyClaudeAuth).toHaveBeenCalledWith({
      claudeCodeOAuthToken: 'sk-ant-oat01-abcdefghi',
    });
  });

  it('Clear OAuth token also clears the stale expiresAt so it does not linger', async () => {
    (api.getMyClaudeAuth as any).mockResolvedValue(
      baseAuth({
        claudeCodeOAuthToken: '****existing',
        claudeCodeOAuthExpiresAt: '2026-12-01T00:00:00.000Z',
        claudeCodeOAuthExpired: false,
      }),
    );
    (api.putMyClaudeAuth as any).mockResolvedValue(baseAuth());

    render(<MyClaudeAuthSection />);
    const clearBtn = await screen.findByRole('button', { name: /clear my oauth token/i });
    fireEvent.click(clearBtn as any);

    await waitFor(() => expect(api.putMyClaudeAuth).toHaveBeenCalledTimes(1));
    expect(api.putMyClaudeAuth).toHaveBeenCalledWith({
      claudeCodeOAuthToken: '',
      claudeCodeOAuthExpiresAt: '',
    });
  });

  it('shows the error message in an alert when PUT rejects', async () => {
    (api.getMyClaudeAuth as any).mockResolvedValue(baseAuth());
    (api.putMyClaudeAuth as any).mockRejectedValue(new Error('500: server fell over'));

    render(<MyClaudeAuthSection />);
    fireEvent.change(await screen.findByLabelText(/anthropic api key/i as any), {
      target: { value: 'sk-ant-api03-x' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save api key/i } as any) as any);

    const alert = await screen.findByRole('alert');
    expect((alert as any).textContent || '').toMatch(/server fell over/);
  });
});
