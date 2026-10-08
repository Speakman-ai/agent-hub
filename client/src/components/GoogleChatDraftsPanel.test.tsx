import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    listGoogleChatDrafts: vi.fn(),
    editGoogleChatDraft: vi.fn(),
    approveGoogleChatDraft: vi.fn(),
    discardGoogleChatDraft: vi.fn(),
  },
}));

import GoogleChatDraftsPanel from './GoogleChatDraftsPanel';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const DRAFT = {
  id: 'd-1',
  sessionId: 's-1',
  spaceId: 'AAA',
  threadName: 'spaces/AAA/threads/T1',
  text: 'Staging is reset.',
  revision: 1,
  status: 'pending',
  error: null,
  sentMessageName: null,
  createdAt: '2026-10-08T10:00:00Z',
  updatedAt: '2026-10-08T10:00:00Z',
};

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

describe('GoogleChatDraftsPanel', () => {
  it('renders nothing without drafts, then picks up a live draft for this session', async () => {
    mockApi.listGoogleChatDrafts.mockResolvedValue({ drafts: [] });
    render(<GoogleChatDraftsPanel sessionId="s-1" />);
    await waitFor(() =>
      expect(mockApi.listGoogleChatDrafts).toHaveBeenCalledWith({
        sessionId: 's-1',
        spaceId: undefined,
      }),
    );
    expect(screen.queryByTestId('session-chat-drafts')).toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('google_chat_draft_update', {
          detail: { draft: { ...DRAFT, id: 'other', sessionId: 's-2' } },
        }),
      );
      window.dispatchEvent(
        new CustomEvent('google_chat_draft_update', { detail: { draft: DRAFT } }),
      );
    });
    expect(await screen.findByTestId('chat-draft-d-1')).toBeTruthy();
    expect(screen.queryByTestId('chat-draft-other')).toBeNull();
  });

  it('edits then discards a draft', async () => {
    mockApi.listGoogleChatDrafts.mockResolvedValue({ drafts: [DRAFT] });
    mockApi.editGoogleChatDraft.mockResolvedValue({ draft: { ...DRAFT, text: 'Reset done.' } });
    mockApi.discardGoogleChatDraft.mockResolvedValue({ draft: { ...DRAFT, status: 'discarded' } });
    render(<GoogleChatDraftsPanel sessionId="s-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText('Edit draft reply'), {
      target: { value: 'Reset done.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
    await waitFor(() =>
      expect(mockApi.editGoogleChatDraft).toHaveBeenCalledWith('d-1', 1, 'Reset done.'),
    );
    expect(await screen.findByText('Reset done.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Discard/ }));
    await waitFor(() => expect(screen.queryByTestId('chat-draft-d-1')).toBeNull());
    expect(mockApi.approveGoogleChatDraft).not.toHaveBeenCalled();
  });

  it('offers only an identical retry or discard for an unconfirmed send', async () => {
    mockApi.listGoogleChatDrafts.mockResolvedValue({
      drafts: [{ ...DRAFT, status: 'unconfirmed', error: 'Google did not confirm the send' }],
    });
    mockApi.approveGoogleChatDraft.mockResolvedValue({ draft: { ...DRAFT, status: 'sent' } });
    render(<GoogleChatDraftsPanel sessionId="s-1" />);

    const card = await screen.findByTestId('chat-draft-d-1');
    expect(card.textContent).toContain('send not confirmed');
    expect(card.textContent).toContain('Google did not confirm the send');
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Retry send/ }));
    await waitFor(() =>
      expect(mockApi.approveGoogleChatDraft).toHaveBeenCalledWith('d-1', 1, undefined),
    );
  });

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function startEditThenSwitch() {
    const edit = deferred<any>();
    mockApi.listGoogleChatDrafts
      .mockResolvedValueOnce({ drafts: [DRAFT], asOf: '2026-10-08T10:00:01.000Z' })
      .mockResolvedValueOnce({
        drafts: [{ ...DRAFT, id: 'b-1', sessionId: 's-2', text: 'B draft' }],
        asOf: '2026-10-08T10:00:02.000Z',
      });
    mockApi.editGoogleChatDraft.mockReturnValueOnce(edit.promise);
    const view = render(<GoogleChatDraftsPanel sessionId="s-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText('Edit draft reply'), { target: { value: 'A edit' } });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));

    view.rerender(<GoogleChatDraftsPanel sessionId="s-2" />);
    expect(await screen.findByTestId('chat-draft-b-1')).toBeTruthy();
    expect(screen.queryByTestId('chat-draft-d-1')).toBeNull();
    return edit;
  }

  it('drops an edit result from the previous session instead of adding it to this one', async () => {
    const edit = await startEditThenSwitch();
    await act(async () =>
      edit.resolve({
        draft: { ...DRAFT, text: 'A edit', updatedAt: '2026-10-08T10:00:03.000Z' },
      }),
    );
    expect(screen.queryByTestId('chat-draft-d-1')).toBeNull();
    expect(screen.getByTestId('chat-draft-b-1')).toBeTruthy();
  });

  it('a failed action from the previous session does not reload over this one', async () => {
    const edit = await startEditThenSwitch();
    expect(mockApi.listGoogleChatDrafts).toHaveBeenCalledTimes(2);
    await act(async () => edit.reject(new Error('boom')));
    expect(mockApi.listGoogleChatDrafts).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('chat-draft-b-1')).toBeTruthy();
  });

  it('an edit refused for a change it had not seen lands on the stale notice, then keeps the edit on request', async () => {
    // The other tab's change has not reached this one yet when it saves.
    mockApi.listGoogleChatDrafts.mockResolvedValueOnce({ drafts: [DRAFT] }).mockResolvedValue({
      drafts: [{ ...DRAFT, text: 'Other tab', revision: 2, updatedAt: '2026-10-08T10:05:00Z' }],
    });
    mockApi.editGoogleChatDraft
      .mockRejectedValueOnce(
        Object.assign(new Error('This draft changed since you reviewed it.'), {
          code: 'google_chat_draft_changed',
        }),
      )
      .mockResolvedValueOnce({ draft: { ...DRAFT, text: 'Mine', revision: 3 } });
    render(<GoogleChatDraftsPanel sessionId="s-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText('Edit draft reply'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(mockApi.editGoogleChatDraft).toHaveBeenCalledWith('d-1', 1, 'Mine'));
    // The refusal reloads the list; the newer version shows next to the edit.
    expect((await screen.findByTestId('chat-draft-stale')).textContent).toContain('Other tab');
    expect((screen.getByLabelText('Edit draft reply') as HTMLTextAreaElement).value).toBe('Mine');

    fireEvent.click(screen.getByRole('button', { name: /Keep my edit/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
    await waitFor(() =>
      expect(mockApi.editGoogleChatDraft).toHaveBeenLastCalledWith('d-1', 2, 'Mine'),
    );
  });

  it('approving outside edit mode sends the revision of the text on screen', async () => {
    mockApi.listGoogleChatDrafts.mockResolvedValue({ drafts: [{ ...DRAFT, revision: 4 }] });
    mockApi.approveGoogleChatDraft.mockResolvedValue({ draft: { ...DRAFT, status: 'sent' } });
    render(<GoogleChatDraftsPanel sessionId="s-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve and send/ }));
    await waitFor(() =>
      expect(mockApi.approveGoogleChatDraft).toHaveBeenCalledWith('d-1', 4, undefined),
    );
  });

  it('shows the newer version when the draft changes during an edit and lets the user pick', async () => {
    mockApi.listGoogleChatDrafts.mockResolvedValue({ drafts: [DRAFT] });
    mockApi.approveGoogleChatDraft.mockResolvedValue({ draft: { ...DRAFT, status: 'sent' } });
    render(<GoogleChatDraftsPanel sessionId="s-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    act(() => {
      window.dispatchEvent(
        new CustomEvent('google_chat_draft_update', {
          detail: {
            draft: { ...DRAFT, text: 'Other tab', revision: 2, updatedAt: '2026-10-08T10:05:00Z' },
          },
        }),
      );
    });
    const stale = await screen.findByTestId('chat-draft-stale');
    expect(stale.textContent).toContain('Other tab');
    expect(
      (screen.getByRole('button', { name: /Save and send/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Use current version/ }));
    expect(screen.queryByTestId('chat-draft-stale')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Approve and send/ }));
    await waitFor(() =>
      expect(mockApi.approveGoogleChatDraft).toHaveBeenCalledWith('d-1', 2, undefined),
    );
  });
});
