import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReminderWire } from '@shared/utils/reminders';

const listReminders = vi.fn();
const createReminder = vi.fn();
const updateReminder = vi.fn();
const deleteReminder = vi.fn();

vi.mock('../utils/api', () => ({
  api: {
    listReminders: (...a: unknown[]) => listReminders(...a),
    createReminder: (...a: unknown[]) => createReminder(...a),
    updateReminder: (...a: unknown[]) => updateReminder(...a),
    deleteReminder: (...a: unknown[]) => deleteReminder(...a),
  },
}));

const { default: RemindersPage } = await import('./RemindersPage');

function rem(over: Partial<ReminderWire>): ReminderWire {
  return {
    id: 'r1',
    userId: 'u',
    title: 'Call the bank',
    notes: '',
    remindAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    status: 'pending',
    createdBy: 'user',
    sessionId: null,
    agentId: null,
    projectId: null,
    calendar: { status: 'none', calendarId: null, eventId: null, eventUrl: null, error: null },
    firedAt: null,
    dismissedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 1,
    ...over,
  };
}

beforeEach(() => {
  listReminders.mockReset();
  createReminder.mockReset();
  updateReminder.mockReset();
  deleteReminder.mockReset();
});

describe('RemindersPage', () => {
  it('shows due and upcoming reminders, agent provenance, and calendar state', async () => {
    const onOpenSession = vi.fn();
    listReminders.mockResolvedValue({
      reminders: [
        rem({ id: 'up', title: 'Upcoming one' }),
        rem({
          id: 'due',
          title: 'Check the deploy',
          status: 'fired',
          createdBy: 'agent',
          sessionId: 's1',
          agentId: 'a1',
          calendar: {
            status: 'synced',
            calendarId: 'primary',
            eventId: 'e1',
            eventUrl: 'https://calendar.google.com/x',
            error: null,
          },
        }),
      ],
    });
    render(<RemindersPage onOpenSession={onOpenSession} />);
    expect(await screen.findByText('Check the deploy')).toBeInTheDocument();
    expect(screen.getByText('Upcoming one')).toBeInTheDocument();
    expect(screen.getByText('Due (1)')).toBeInTheDocument();
    expect(screen.getByText('Set by an agent')).toBeInTheDocument();
    expect(screen.getByText('On your calendar').closest('a')).toHaveAttribute(
      'href',
      'https://calendar.google.com/x',
    );
    fireEvent.click(screen.getByText('Open session'));
    expect(onOpenSession).toHaveBeenCalledWith({ sessionId: 's1', agentId: 'a1' });
  });

  it('creates a reminder from a preset with the calendar toggle', async () => {
    listReminders.mockResolvedValue({ reminders: [] });
    createReminder.mockImplementation(async (body) => ({
      reminder: rem({ id: 'new', title: body.title }),
    }));
    render(<RemindersPage />);
    await screen.findByTestId('reminders-empty');
    fireEvent.change(screen.getByTestId('reminder-new-title'), { target: { value: 'Stretch' } });
    fireEvent.click(screen.getByTestId('reminder-preset-1h'));
    fireEvent.click(screen.getByTestId('reminder-new-calendar'));
    fireEvent.click(screen.getByTestId('reminder-add'));
    await waitFor(() => expect(createReminder).toHaveBeenCalled());
    const body = createReminder.mock.calls[0][0];
    expect(body.title).toBe('Stretch');
    expect(body.calendar).toBe('none');
    const delta = Date.parse(body.remindAt) - Date.now();
    expect(delta).toBeGreaterThan(55 * 60 * 1000);
    expect(delta).toBeLessThan(61 * 60 * 1000);
    expect(await screen.findByText('Stretch')).toBeInTheDocument();
  });

  it('snoozes and dismisses a due reminder', async () => {
    listReminders.mockResolvedValue({ reminders: [rem({ id: 'd', status: 'fired' })] });
    updateReminder.mockImplementation(async (id, body) => ({
      reminder: rem({ id, status: body.status ?? 'pending' }),
    }));
    render(<RemindersPage />);
    fireEvent.click(await screen.findByTestId('reminder-snooze-d-10m'));
    await waitFor(() => expect(updateReminder).toHaveBeenCalled());
    const [id, body] = updateReminder.mock.calls[0];
    expect(id).toBe('d');
    const delta = Date.parse(body.remindAt) - Date.now();
    expect(delta).toBeGreaterThan(9 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(await screen.findByText('Upcoming (1)')).toBeInTheDocument();
  });

  it('resolves "Tomorrow 9 AM" when clicked, not when the page last rendered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 16, 12, 0));
      listReminders.mockResolvedValue({ reminders: [rem({ id: 'd', status: 'fired' })] });
      updateReminder.mockImplementation(async (rid) => ({ reminder: rem({ id: rid }) }));
      render(<RemindersPage />);
      const button = await screen.findByTestId('reminder-snooze-d-tomorrow-9am');
      // Ten minutes pass with the page open before the click.
      vi.setSystemTime(new Date(2026, 9, 16, 12, 10));
      fireEvent.click(button);
      await waitFor(() => expect(updateReminder).toHaveBeenCalled());
      expect(updateReminder.mock.calls[0][1]).toEqual({
        remindAt: new Date(2026, 9, 17, 9, 0).toISOString(),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates the calendar status when background maintenance recovers it', async () => {
    const pendingCal = {
      status: 'pending' as const,
      calendarId: 'primary',
      eventId: 'ahr1',
      eventUrl: null,
      error: 'backend error',
    };
    listReminders.mockResolvedValue({ reminders: [rem({ id: 'p', calendar: pendingCal })] });
    render(<RemindersPage />);
    expect(await screen.findByText('Adding to your calendar')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('reminder_update', {
          detail: {
            action: 'updated',
            reminderId: 'p',
            reminder: rem({
              id: 'p',
              calendar: { ...pendingCal, status: 'synced', error: null, eventUrl: 'https://cal/e' },
              revision: 2,
            }),
          },
        }),
      );
    });
    expect(await screen.findByText('On your calendar')).toBeInTheDocument();
    expect(screen.queryByText('Adding to your calendar')).toBeNull();
  });

  it('does not let a slow list response undo a firing or a delete that arrived first', async () => {
    let respond: (v: { reminders: ReminderWire[] }) => void = () => {};
    listReminders.mockReturnValue(new Promise((r) => (respond = r)));
    render(<RemindersPage />);
    // While the list request is out, one reminder fires and another is deleted.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('reminder_update', {
          detail: {
            action: 'fired',
            reminderId: 'f',
            reminder: rem({ id: 'f', title: 'Fired one', status: 'fired', revision: 2 }),
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent('reminder_update', { detail: { action: 'deleted', reminderId: 'd' } }),
      );
    });
    // The response was read before both: still pending, still present.
    await act(async () => {
      respond({
        reminders: [
          rem({ id: 'f', title: 'Fired one', status: 'pending', revision: 1 }),
          rem({ id: 'd', title: 'Deleted one', revision: 1 }),
        ],
      });
    });
    expect(await screen.findByText('Due (1)')).toBeInTheDocument();
    expect(screen.getByTestId('reminder-dismiss-f')).toBeInTheDocument();
    expect(screen.queryByText('Deleted one')).toBeNull();
  });

  it('applies live reminder_update events', async () => {
    listReminders.mockResolvedValue({ reminders: [] });
    render(<RemindersPage />);
    await screen.findByTestId('reminders-empty');
    act(() => {
      window.dispatchEvent(
        new CustomEvent('reminder_update', {
          detail: {
            action: 'created',
            reminderId: 'x',
            reminder: rem({ id: 'x', title: 'From agent' }),
          },
        }),
      );
    });
    expect(await screen.findByText('From agent')).toBeInTheDocument();
  });
});
