import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RoutineFromRecordingDialog, { type RoutineDialogApi } from './RoutineFromRecordingDialog';

function makeClient(overrides: Partial<RoutineDialogApi> = {}) {
  return {
    draftRoutineFromRecording: vi.fn(async () => ({
      projectId: 'p1',
      agentId: 'ops',
      agentName: 'Ops',
      artifactId: 'art-1',
      steps: 4,
      draft: {
        name: 'weekly-export',
        description: 'Export the weekly report.',
        body: '## Steps\n1. Open reports\n',
      },
    })),
    createProjectSkill: vi.fn(async () => ({ id: 'weekly-export' })),
    ...overrides,
  };
}

describe('RoutineFromRecordingDialog', () => {
  it('drafts from the recording and saves the edited skill, then finishes', async () => {
    const client = makeClient();
    render(
      <RoutineFromRecordingDialog
        sessionId="s1"
        artifactId="art-1"
        onClose={vi.fn()}
        client={client}
      />,
    );

    fireEvent.change(screen.getByTestId('routine-goal'), { target: { value: 'weekly report' } });
    await act(async () => fireEvent.click(screen.getByTestId('routine-draft')));
    expect(client.draftRoutineFromRecording).toHaveBeenCalledWith('s1', {
      artifactId: 'art-1',
      goal: 'weekly report',
    });

    const body = await screen.findByTestId('routine-body');
    expect((body as HTMLTextAreaElement).value).toContain('Open reports');
    fireEvent.change(body, { target: { value: '## Steps\n1. Open the reports page\n' } });
    await act(async () => fireEvent.click(screen.getByTestId('routine-save')));
    expect(client.createProjectSkill).toHaveBeenCalledWith('p1', {
      name: 'weekly-export',
      description: 'Export the weekly report.',
      category: 'general',
      body: '## Steps\n1. Open the reports page\n',
    });

    expect(await screen.findByTestId('routine-saved')).toHaveTextContent('weekly-export');
    expect(screen.getByTestId('routine-done')).toBeInTheDocument();
    expect(screen.queryByTestId('routine-schedule')).toBeNull();
  });

  it('blocks saving an invalid name and surfaces draft errors', async () => {
    const client = makeClient({
      draftRoutineFromRecording: vi
        .fn()
        .mockRejectedValueOnce(new Error('No engines configured'))
        .mockResolvedValueOnce({
          projectId: 'p1',
          agentId: 'ops',
          agentName: 'Ops',
          artifactId: 'art-1',
          steps: 1,
          draft: { name: 'ok', description: 'd', body: 'b' },
        }),
    });
    render(
      <RoutineFromRecordingDialog
        sessionId="s1"
        artifactId="art-1"
        onClose={vi.fn()}
        client={client}
      />,
    );
    await act(async () => fireEvent.click(screen.getByTestId('routine-draft')));
    expect(screen.getByRole('alert')).toHaveTextContent('No engines configured');

    await act(async () => fireEvent.click(screen.getByTestId('routine-draft')));
    fireEvent.change(await screen.findByTestId('routine-name'), {
      target: { value: 'Bad Name' },
    });
    expect(screen.getByTestId('routine-save')).toBeDisabled();
    await waitFor(() => expect(client.createProjectSkill).not.toHaveBeenCalled());
  });
});
