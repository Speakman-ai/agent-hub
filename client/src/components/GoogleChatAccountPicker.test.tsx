import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockApi = vi.hoisted(() => ({
  getGoogleChatAccount: vi.fn(),
  setGoogleChatAccount: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: mockApi }));

import GoogleChatAccountPicker from './GoogleChatAccountPicker';

const candidates = [
  { accountId: 'p', email: 'me@gmail.com', isDefault: true, workspace: false, hasChatScope: false },
  {
    accountId: 'w',
    email: 'me@work.example',
    isDefault: false,
    workspace: true,
    hasChatScope: true,
  },
  {
    accountId: 'x',
    email: 'me@other.example',
    isDefault: false,
    workspace: true,
    hasChatScope: true,
  },
];

describe('GoogleChatAccountPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getGoogleChatAccount.mockResolvedValue({
      account: { accountId: 'w', email: 'me@work.example' },
      boundEmail: 'me@work.example',
      candidates,
    });
  });

  it('lists Workspace accounts only and moves Chat after confirmation', async () => {
    mockApi.setGoogleChatAccount.mockResolvedValue({
      account: { accountId: 'x', email: 'me@other.example' },
      boundEmail: 'me@other.example',
      candidates,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<GoogleChatAccountPicker />);

    const select = (await screen.findByLabelText('Google Chat account')) as HTMLSelectElement;
    expect(select.value).toBe('w');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'me@work.example',
      'me@other.example',
    ]);

    fireEvent.change(select, { target: { value: 'x' } });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/agent replies waiting/));
    await waitFor(() => expect(mockApi.setGoogleChatAccount).toHaveBeenCalledWith('x'));
    await waitFor(() => expect(select.value).toBe('x'));
    confirm.mockRestore();
  });

  it('keeps the current account when the move is not confirmed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<GoogleChatAccountPicker />);
    fireEvent.change(await screen.findByLabelText('Google Chat account'), {
      target: { value: 'x' },
    });
    expect(mockApi.setGoogleChatAccount).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('says when the Chat account is no longer linked', async () => {
    mockApi.getGoogleChatAccount.mockResolvedValue({
      account: null,
      boundEmail: 'gone@work.example',
      candidates,
    });
    render(<GoogleChatAccountPicker />);
    expect(await screen.findByRole('status')).toHaveTextContent(/gone@work.example/);
  });
});
