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
    createCron: vi.fn(async () => ({ id: 3 })),
    ...overrides,
  };
}

describe('RoutineFromRecordingDialog', () => {
  it('drafts from the recording, saves the edited skill and schedules it as a routine', async () => {
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

    await screen.findByTestId('routine-saved');
    await act(async () => fireEvent.click(screen.getByTestId('routine-schedule')));
    expect(client.createCron).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'p1',
        skill_principal_agent_id: 'ops',
        routine_skill: 'weekly-export',
        schedule: '0 9 * * 1-5',
      }),
    );
    expect(await screen.findByTestId('routine-done')).toHaveTextContent(/notifications/);
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
