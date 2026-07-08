import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getProjects: vi.fn(),
    getBoard: vi.fn(),
    createCard: vi.fn(),
  },
}));

import CaptureToTicketModal from './CaptureToTicketModal';
import { api } from '../utils/api';
import type { CaptureCardDraft } from '@shared/utils/captureCard';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const draft: CaptureCardDraft = {
  title: 'Ship the release',
  description: 'From ceo@example.com\n\nSource: https://mail.google.com/mail/u/0/#all/t1',
  source: {
    sourceType: 'email',
    sourceId: 'msg-9',
    sourceMeta: { kind: 'gmail', threadId: 't1', deepLink: 'https://mail.google.com/x' },
  },
};

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CaptureToTicketModal', () => {
  it('creates a card in the chosen project/column with the source stamped', async () => {
    mockApi.getProjects.mockResolvedValueOnce([
      { id: 'proj-a', name: 'Project A', cwd: '/a' },
      { id: 'proj-b', name: 'Project B', cwd: '/b' },
    ]);
    mockApi.getBoard.mockResolvedValueOnce({
      columns: [
        { id: 'col-todo', name: 'To Do' },
        { id: 'col-doing', name: 'In Progress' },
      ],
    });
    mockApi.createCard.mockResolvedValueOnce({ id: 'card-1' });

    const onClose = vi.fn();
    render(<CaptureToTicketModal draft={draft} onClose={onClose} />);

    // Board columns load for the default (first) project.
    await waitFor(() => expect(mockApi.getBoard).toHaveBeenCalledWith('proj-a'));

    // Title is prefilled from the draft.
    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    expect(titleInput.value).toBe('Ship the release');

    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));

    await waitFor(() => {
      expect(mockApi.createCard).toHaveBeenCalledWith('proj-a', {
        title: 'Ship the release',
        description: draft.description,
        columnId: 'col-todo',
        source: draft.source,
      });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('reloads columns when the project changes and posts to the new project', async () => {
    mockApi.getProjects.mockResolvedValueOnce([
      { id: 'proj-a', name: 'Project A', cwd: '/a' },
      { id: 'proj-b', name: 'Project B', cwd: '/b' },
    ]);
    mockApi.getBoard
      .mockResolvedValueOnce({ columns: [{ id: 'a-todo', name: 'To Do' }] })
      .mockResolvedValueOnce({ columns: [{ id: 'b-todo', name: 'Backlog' }] });
    mockApi.createCard.mockResolvedValueOnce({ id: 'card-2' });

    render(<CaptureToTicketModal draft={draft} onClose={vi.fn()} />);

    await waitFor(() => expect(mockApi.getBoard).toHaveBeenCalledWith('proj-a'));

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-b' } });
    await waitFor(() => expect(mockApi.getBoard).toHaveBeenCalledWith('proj-b'));

    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));

    await waitFor(() => {
      expect(mockApi.createCard).toHaveBeenCalledWith(
        'proj-b',
        expect.objectContaining({ columnId: 'b-todo', source: draft.source }),
      );
    });
  });

  it('surfaces an error and does not close when card creation fails', async () => {
    mockApi.getProjects.mockResolvedValueOnce([{ id: 'proj-a', name: 'Project A', cwd: '/a' }]);
    mockApi.getBoard.mockResolvedValueOnce({ columns: [{ id: 'col-todo', name: 'To Do' }] });
    mockApi.createCard.mockRejectedValueOnce(new Error('boom'));

    const onClose = vi.fn();
    render(<CaptureToTicketModal draft={draft} onClose={onClose} />);

    await waitFor(() => expect(mockApi.getBoard).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
